import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resetState, initSessionArtifacts, getNotebookPath } from "./state.js";
import { startGalaxyPoller, stopGalaxyPoller } from "./galaxy-poller.js";
import {
  upsertSessionSummaryBlock,
  readNotebook,
  withNotebookLock,
  writeNotebook,
  type SessionSummaryYaml,
} from "./notebook-writer.js";
import { activeGalaxyStatus, type ActiveGalaxyStatus } from "./profiles.js";
import * as fs from "fs";
import * as path from "path";

// Tracked across the session so the shutdown handler can write a complete
// `loom-session` block. ctx is per-event; we can't read it on shutdown
// directly, so capture what we need on session_start.
let sessionStart: { id: string; startedAt: string } | null = null;

export function registerSessionLifecycle(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setToolsExpanded(false);

    resetState();

    syncSessionJsonlSymlink(ctx);

    initSessionArtifacts(process.cwd());

    // Background poller for in-flight Galaxy invocations (#67 part 2).
    // Idempotent — start() stops any prior timer first.
    startGalaxyPoller();

    sessionStart = {
      id: ctx.sessionManager?.getSessionId?.() ?? `session-${Date.now()}`,
      startedAt: new Date().toISOString(),
    };

    const freshSession = process.env.LOOM_FRESH_SESSION === "1";

    if (freshSession || process.argv.includes("--continue")) {
      return;
    }

    sendStartupGreeting(pi, ctx);
  });

  // Compaction recovery: snapshot the notebook so the post-compact agent can
  // re-orient by re-reading. Notebook is the source of truth — no plan struct
  // to persist.
  pi.on("session_before_compact", async () => {
    snapshotNotebook(pi);
    return {};
  });

  pi.on("session_shutdown", async () => {
    stopGalaxyPoller();
    await writeSessionSummary();
    snapshotNotebook(pi);
  });
}

function snapshotNotebook(pi: ExtensionAPI): void {
  const nbPath = getNotebookPath();
  if (!nbPath) return;
  try {
    const content = fs.readFileSync(nbPath, "utf-8");
    pi.appendEntry("notebook_snapshot", { path: nbPath, content });
  } catch (err) {
    console.error("notebook snapshot failed:", err);
  }
}

/**
 * Write a `loom-session` block to the notebook on shutdown so a future
 * session can see what was running. `orphaned_active_steps` is 0 today
 * (typed plan-step blocks don't exist yet); this writer is the receiving
 * end of that future change.
 *
 * Upserts by session id (#260): Pi reuses the same session id when an idle
 * session is resumed, so a second shutdown continues the existing block
 * rather than appending a duplicate under the same id.
 *
 * Uses the same per-path mutex chain as the invocation poller so a
 * concurrent `galaxy_invocation_check_*` write at shutdown doesn't lose
 * the summary.
 */
async function writeSessionSummary(): Promise<void> {
  const nbPath = getNotebookPath();
  if (!nbPath || !sessionStart) return;
  const summary: SessionSummaryYaml = {
    id: sessionStart.id,
    startedAt: sessionStart.startedAt,
    endedAt: new Date().toISOString(),
    notebook: path.basename(nbPath),
    orphanedActiveSteps: countOrphanedActiveSteps(),
  };
  try {
    await withNotebookLock(nbPath, async () => {
      const content = await readNotebook(nbPath);
      const updated = upsertSessionSummaryBlock(content, summary);
      await writeNotebook(nbPath, updated);
    });
  } catch (err) {
    console.error("session summary write failed:", err);
  }
}

/**
 * Count plan steps left in the `active` state when the session ends. Stub
 * for now -- typed `loom-step` blocks don't exist yet. When they do, this
 * scans the notebook for blocks with `state: active` and rewrites them to
 * `state: blocked` with `blocked_reason: session_ended_while_active`,
 * returning the count.
 */
function countOrphanedActiveSteps(): number {
  return 0;
}

/**
 * Drop a `session.jsonl` symlink in the cwd pointing at pi's authoritative
 * session file (~/.pi/agent/sessions/<encoded-cwd>/). Best-effort.
 */
function syncSessionJsonlSymlink(ctx: ExtensionContext): void {
  try {
    const target = ctx.sessionManager?.getSessionFile?.();
    if (!target) return;
    const linkPath = path.join(process.cwd(), "session.jsonl");
    try {
      const existing = fs.lstatSync(linkPath);
      if (!existing.isSymbolicLink()) {
        console.warn("session.jsonl exists and is not a Loom symlink; leaving it untouched");
        return;
      }
      fs.unlinkSync(linkPath);
    } catch {
      // link didn't exist -- fall through to create
    }
    fs.symlinkSync(target, linkPath);
  } catch (err) {
    console.error("session.jsonl symlink failed:", err);
  }
}

type GreetingAction =
  | { kind: "model"; message: string }
  | { kind: "notify"; text: string; level: "info" | "warning" };

/**
 * Decide the startup greeting from the active Galaxy credential status. Pure so
 * it can be unit-tested without a live session.
 *
 * `usable` keeps a real model turn -- it has to nudge galaxy_connect(). The
 * other two states are pure pleasantries, so they render as a static notify:
 * no model round-trip, no leaked instruction, and the same call surfaces in
 * both the terminal TUI and Orbit (which renders the notify RPC event).
 */
export function planStartupGreeting(status: ActiveGalaxyStatus, isOrbit: boolean): GreetingAction {
  if (status === "usable") {
    const message =
      `Session started in this project directory. Read \`notebook.md\` to see prior work. ` +
      (isOrbit
        ? `Reply with one short sentence: "What do you want to work on next?" ` +
          `No greeting, no emojis, no product branding.`
        : `Give a brief welcome, then ask what to work on next, referencing the notebook contents if there is prior work. ` +
          `Keep it to 2-3 sentences.`) +
      ` Galaxy credentials are configured -- call galaxy_connect() to establish the connection.` +
      ` Do NOT call other Galaxy tools until connected.`;
    return { kind: "model", message };
  }

  if (status === "configured-unusable") {
    return {
      kind: "notify",
      level: "warning",
      text:
        `Welcome to Loom. A Galaxy profile is configured, but its API key only decrypts inside Orbit -- ` +
        `Galaxy tools won't work in this terminal. Run from Orbit, export GALAXY_API_KEY, or /connect a server. ` +
        `What would you like to work on?`,
    };
  }

  return {
    kind: "notify",
    level: "info",
    text:
      `Welcome to Loom. No Galaxy server is configured, so work runs locally for now -- use /connect to set one up. ` +
      `What would you like to work on?`,
  };
}

export function sendStartupGreeting(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const isOrbit = process.env.LOOM_SHELL_KIND === "orbit";
  const action = planStartupGreeting(activeGalaxyStatus(), isOrbit);
  if (action.kind === "model") {
    pi.sendUserMessage(action.message);
  } else {
    ctx.ui.notify(action.text, action.level);
  }
}
