/**
 * Does Orbit's brain (extensions/orbit) load and register in a worker at all? Boots it the way the
 * flag worker does (bootOrbit), opens the session registry and writes and re-reads one attempt,
 * then posts { ok, mode } or { ok: false, error }. Built and loaded by scripts/preflight-orbit.mjs and
 * e2e/orbit-preflight-drive.cjs; nothing ships it.
 *
 * The conformance test (pi-host.orbit.test.ts) boots the same brain under Node, where process.pid,
 * Buffer and the builtins all exist. This is what it can't see: the bundle and the worker realm.
 */
import { setRecordStore } from "../../../../../extensions/orbit/record-store";
import { createPageRecordStore } from "../../../../../extensions/orbit/record-store-page";
import {
  closeSessionRegistry,
  openSessionRegistry,
} from "../../../../../extensions/orbit/registry-runtime";
import { createMemoryLedger } from "../../../../../extensions/orbit/submission-ledger";
import { bootOrbit } from "./boot";

const SERVER = "http://galaxy.invalid";
const ANALYSIS = "/orbit/preflight";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

async function preflight(): Promise<{ mode: string; tools: number }> {
  const { host } = bootOrbit({
    capabilities: ["llm", "local", "read", "write"],
    galaxy: { fetch: async () => json({}), url: SERVER },
    ledger: createMemoryLedger(),
    secrets: () => [],
    ui: { ask: async () => undefined, notify: () => {} },
  });
  setRecordStore(createPageRecordStore({ key: `${ANALYSIS}/notebook.md`, pageId: "preflight" }));

  // The registry over the page profile's in-memory fs, named by the shimmed process.pid.
  const { session } = openSessionRegistry({
    analysisDir: ANALYSIS,
    sessionId: "preflight",
    serverUrl: SERVER,
    heartbeatMs: null,
  });
  const id = session.store.newAttemptId();
  session.store.update((draft) => {
    draft.attempts[id] = {
      attempt_id: id,
      kind: "tool",
      binding: { step_anchor: "unattributed", bound_at: new Date().toISOString() },
      server_url: SERVER,
      history_id: "preflight",
      handoff_eligible: false,
    };
  });
  const mode = session.store.mode;
  closeSessionRegistry();
  const reread = openSessionRegistry({
    analysisDir: ANALYSIS,
    sessionId: "preflight-reread",
    serverUrl: SERVER,
    heartbeatMs: null,
  });
  const found = id in reread.session.store.snapshot().attempts;
  closeSessionRegistry();
  if (!found) throw new Error(`registry: attempt ${id} was written but not read back`);
  return { mode, tools: host.api.getAllTools().length };
}

preflight().then(
  (result) => postMessage({ ok: true, ...result }),
  (error: unknown) =>
    postMessage({
      ok: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    }),
);
