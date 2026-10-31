/** Starts the preflight worker and leaves its answer where e2e/orbit-preflight-drive.cjs reads it. */
const result = globalThis as unknown as { preflight?: unknown };
const worker = new Worker(new URL("./preflight.worker.ts", import.meta.url), { type: "module" });
worker.onmessage = (event) => {
  result.preflight = event.data;
};
worker.onerror = (event) => {
  result.preflight = { ok: false, error: `worker failed to start: ${event.message}` };
};
