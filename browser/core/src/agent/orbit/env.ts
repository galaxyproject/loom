/**
 * The Node globals Orbit's brain reads, installed in the worker before any Orbit module loads.
 * Imported first by the Orbit entry; the default worker never reaches it.
 */
import { Buffer } from "./shims/buffer";

/** The pseudo directory each conversation runs in; Orbit's cwd-relative paths resolve under it. */
let cwd = "/orbit";

export function setOrbitCwd(dir: string): void {
  cwd = dir;
}

const g = globalThis as unknown as { process?: Record<string, unknown>; Buffer?: unknown };

// Member by member: the dev server's defines leave a process with only `env` on it.
const proc = (g.process ??= {});
for (const [name, value] of Object.entries(nodeProcess())) proc[name] ??= value;

function nodeProcess(): Record<string, unknown> {
  return {
    env: {} as Record<string, string | undefined>,
    argv: [] as string[],
    cwd: () => cwd,
    platform: "browser",
    versions: {},
    // RegistryStore names its lock after process.pid and parseLock rejects a lock without a
    // numeric pid, so a missing pid leaves /pending and /approve read-only. One worker, one
    // in-memory registry fs: a constant is enough.
    pid: 1,
    exitCode: undefined,
    on: () => g.process,
    off: () => g.process,
    once: () => g.process,
    emitWarning: () => {},
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
      queueMicrotask(() => fn(...args)),
  };
}

if (!g.Buffer) g.Buffer = Buffer;
