/**
 * One worker, one conversation. Kept tiny and free of Orbit imports so the time to its first line
 * is thread and isolate startup, and the import() below is the whole of module load.
 */
import cp from "node:child_process";
import module from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

import { now, type Marks } from "./clock";
import { ledger } from "./stubs/inert";
import { inlineGlobs, rawModule } from "./vite-shims";

const marks: Marks = { workerStart: now() };

export interface WorkerData {
  /** The Orbit entry: the bundle, or orbit-entry.ts under tsx. */
  entry: string;
  /** Unbundled only: where the chokidar, better-sqlite3 and galaxy-ops redirects point. */
  redirects?: Record<string, string>;
  /** V8's on-disk compile cache for the bundle, shared by every worker and run. */
  compileCache?: string;
  options: import("./orbit-entry").BootOptions;
}

const data = workerData as WorkerData;

// The test's answers, so git.ts takes the same branch it does there; nothing is spawned.
let initialised = false;
const answers: Record<string, (...a: unknown[]) => unknown> = {
  execFileSync: (file, args) => {
    const line = [file, ...(Array.isArray(args) ? args : [])].join(" ");
    if (line === "git rev-parse --is-inside-work-tree" && !initialised) {
      throw new Error("fatal: not a git repository");
    }
    if (line === "git init") initialised = true;
    if (line === "git config --bool loom.managed") return initialised ? "true" : "";
    return "";
  },
  execSync: () => "",
  spawnSync: () => ({ status: 0, stdout: "", stderr: "", signal: null, pid: 0, output: [] }),
};
const calls: Record<string, number> = {};
for (const key of ["execFileSync", "execSync", "spawnSync", "exec", "execFile", "spawn", "fork"]) {
  (cp as unknown as Record<string, unknown>)[key] = (...a: unknown[]) => {
    calls[key] = (calls[key] ?? 0) + 1;
    const answer = answers[key];
    if (answer) return answer(...a);
    throw new Error(`child_process.${key} stubbed by the boot bench: ${String(a[0])}`);
  };
}
module.syncBuiltinESMExports();

// What the bundle's aliases do, for the unbundled run: in-thread, so only this worker sees them.
if (data.redirects) {
  const redirects = data.redirects;
  module.registerHooks({
    resolve(specifier, context, next) {
      const to = redirects[specifier];
      if (to) return { url: pathToFileURL(to).href, shortCircuit: true };
      const resolved = next(specifier, context);
      const swap = redirects[resolved.url];
      return swap ? { ...resolved, url: pathToFileURL(swap).href } : resolved;
    },
    load(url, context, next) {
      const u = new URL(url);
      if (u.protocol === "file:" && u.searchParams.has("raw")) {
        return { format: "module", source: rawModule(fileURLToPath(u)), shortCircuit: true };
      }
      const loaded = next(url, context);
      if (!/\/core\/src\/agent\/skills\.ts$/.test(u.pathname)) return loaded;
      const file = fileURLToPath(u);
      return { ...loaded, source: inlineGlobs(String(loaded.source), dirname(file)) };
    },
  });
}

if (data.compileCache) module.enableCompileCache(data.compileCache);

try {
  const entry = (await import(pathToFileURL(data.entry).href)) as typeof import("./orbit-entry");
  marks.loaded = now();
  const result = await entry.boot(data.options, marks);
  parentPort!.postMessage({ ok: true, result, calls, inert: ledger() });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    marks,
  });
}
