/**
 * The registry as the running brain holds it: one `RegistryStore` per
 * session, opened at session start under `<analysis>/.loom/state/` and closed
 * at shutdown.
 *
 * The store's signing key lives only in that object, so "this session's own
 * state" means "written by this process since session start". Anything on
 * disk from before -- an earlier session, a clone, a hand edit -- comes in
 * through the import rule: approvals restored, never live.
 *
 * A registry that cannot be opened never blocks the session. It degrades to
 * read-only with one notice, and the commands that would write say why they
 * can't.
 */

import * as fs from "fs";
import { capabilityProfile } from "../../shared/capability-profile.js";
import { appendActivityEvent } from "./activity";
import { memoryRegistryFs } from "./registry-memory-fs";
import {
  RegistryStore,
  canonicalJson,
  type LoadOutcome,
  type Registry,
  type RegistryFs,
} from "./registry";
import { revokeAttempts, type Drift } from "./registry-proposal";

/** Well inside the lock's two-minute staleness limit. */
const HEARTBEAT_MS = 30_000;

export interface SessionRegistry {
  store: RegistryStore;
  analysisDir: string;
  /** Set when the store could not be opened at all; it stays read-only. */
  unavailable?: string;
}

let current: SessionRegistry | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

// One Map per brain process: a page notebook has no .loom/state beside it, and
// a second session_start in the same worker reopens what the first wrote. The
// paths inside it carry the analysis dir, so two records opened by one worker
// keep separate registries on the one Map.
let pageFs: RegistryFs | null = null;
function defaultRegistryFs(): RegistryFs {
  if (capabilityProfile().notebook !== "page") return fs;
  return (pageFs ??= memoryRegistryFs());
}

export function getSessionRegistry(): SessionRegistry | null {
  return current;
}

export interface OpenOptions {
  analysisDir: string;
  sessionId: string;
  serverUrl: string;
  fs?: RegistryFs;
  clock?: () => number;
  /** Tests turn the timer off. */
  heartbeatMs?: number | null;
}

/**
 * Open this session's registry, replacing any previous one. Returns the
 * notice the user should see, or null when there is nothing to say.
 */
export function openSessionRegistry(opts: OpenOptions): {
  session: SessionRegistry;
  outcome: LoadOutcome | null;
  notice: string | null;
} {
  closeSessionRegistry();
  const store = new RegistryStore({
    analysisDir: opts.analysisDir,
    serverUrl: opts.serverUrl,
    sessionId: opts.sessionId,
    fs: opts.fs ?? defaultRegistryFs(),
    clock: opts.clock ?? Date.now,
  });
  const session: SessionRegistry = { store, analysisDir: opts.analysisDir };
  let outcome: LoadOutcome | null = null;
  try {
    outcome = store.open();
  } catch (err) {
    session.unavailable = (err as Error).message;
    try {
      store.close();
    } catch {
      // nothing held
    }
  }
  current = session;

  const interval = opts.heartbeatMs === undefined ? HEARTBEAT_MS : opts.heartbeatMs;
  if (store.mode === "writer" && interval !== null) {
    heartbeat = setInterval(() => {
      try {
        // False means the lock was taken over and the store is read-only now.
        if (!store.heartbeat()) stopHeartbeat();
      } catch {
        // A failed beat (a busy rename, say) is retried on the next tick.
      }
    }, interval);
    heartbeat.unref?.();
  }

  const restored = Object.values(store.snapshot().attempts).filter(
    (a) => a.approval?.status === "restored",
  ).length;
  appendActivityEvent(opts.analysisDir, {
    timestamp: new Date().toISOString(),
    kind: "registry.opened",
    source: "harness",
    payload: {
      mode: store.mode,
      outcome: outcome?.kind ?? "unavailable",
      ...(session.unavailable ? { error: session.unavailable } : {}),
      restored_approvals: restored,
      notices: [...store.notices],
    },
  });
  return { session, outcome, notice: openNotice(session, outcome, restored) };
}

function openNotice(
  session: SessionRegistry,
  outcome: LoadOutcome | null,
  restored: number,
): string | null {
  const { store } = session;
  if (session.unavailable) {
    return (
      `The approval registry couldn't be opened (${session.unavailable}), so it is read-only ` +
      `this session: /approve and /revoke will refuse. Everything else works as usual.`
    );
  }
  if (store.mode === "read-only") {
    return (
      `${store.notices[store.notices.length - 1] ?? "The approval registry opened read-only."} ` +
      `/approve and /revoke will refuse in this session.`
    );
  }
  if (outcome?.kind === "rejected") {
    return `The approval registry on disk was unreadable (${outcome.reason}); it was set aside and this session starts a fresh one.`;
  }
  if (restored > 0) {
    return (
      `${restored} approval(s) from an earlier session were restored, not live -- an approval ` +
      `only counts in the session that recorded it. /pending lists them; /approve re-approves.`
    );
  }
  return null;
}

function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

export function closeSessionRegistry(): void {
  stopHeartbeat();
  if (current) {
    try {
      current.store.close();
    } catch {
      // best effort: a stale lock is taken over after two minutes anyway
    }
  }
  current = null;
}

/**
 * At shutdown: the attempts whose runs this session last saw still going, so
 * the next session knows what may have finished without anyone watching.
 * Returns how many; never implies the remote run stopped.
 */
export function recordActiveAtShutdown(session: SessionRegistry | null = current): number {
  if (!session || session.store.mode !== "writer") return 0;
  const active = Object.values(session.store.snapshot().attempts)
    .filter((a) => a.submission && a.reservation?.state !== "released")
    .filter((a) => !a.evaluation || a.evaluation.execution === "unknown")
    .map((a) => a.attempt_id)
    .sort();
  const current = session.store.snapshot().supervision.active_at_shutdown;
  if (canonicalJson(current) === canonicalJson(active)) return active.length;
  try {
    session.store.update((draft) => {
      draft.supervision.active_at_shutdown = active;
    });
  } catch (err) {
    console.error("[registry] active_at_shutdown not written:", err);
  }
  return active.length;
}

/**
 * Revocations decided but not yet written to the registry, per store. Readers
 * go through `sessionView`, which applies them, so an approval stops counting
 * the moment it's revoked even if the write has to wait.
 */
const heldByStore = new WeakMap<RegistryStore, Map<string, Drift>>();

export function heldRevocations(store: RegistryStore): Map<string, Drift> {
  let held = heldByStore.get(store);
  if (!held) heldByStore.set(store, (held = new Map()));
  return held;
}

/** Write what's held when the store can take it. Returns the ids written. */
export function flushHeldRevocations(store: RegistryStore): Set<string> {
  const held = heldRevocations(store);
  if (held.size === 0 || store.mode !== "writer") return new Set();
  const ids = [...held.keys()];
  try {
    revokeAttempts(store, ids);
  } catch {
    return new Set();
  }
  for (const id of ids) held.delete(id);
  return new Set(ids);
}

/** The registry as this session must read it: held revocations applied. */
export function sessionView(session: SessionRegistry): Registry {
  const view = session.store.snapshot();
  for (const id of heldRevocations(session.store).keys()) {
    const approval = view.attempts[id]?.approval;
    if (approval?.status === "live") approval.status = "revoked";
  }
  return view;
}
