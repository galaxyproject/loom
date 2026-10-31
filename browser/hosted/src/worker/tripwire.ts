/**
 * Records every filesystem and child_process call made after it is installed, for the tests that
 * hold the worker to zero reaches. The worker installs it before Orbit registers, so anything Orbit
 * does from then on -- registration, the session start, every turn -- is seen.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";

export function installTripwire(report: (api: string) => void): void {
  const modules: Array<[string, Record<string, unknown>]> = [
    ["fs", fs as unknown as Record<string, unknown>],
    ["fs/promises", fsp as unknown as Record<string, unknown>],
    ["child_process", childProcess as unknown as Record<string, unknown>],
    // Only the calls that hand back a place on disk: the rest of os is harmless introspection.
    ["os", { homedir: os.homedir, tmpdir: os.tmpdir, userInfo: os.userInfo }],
  ];
  for (const [name, mod] of modules) {
    for (const key of Object.keys(mod)) {
      const value = mod[key];
      // Classes (Stats, ReadStream) are constructed by Node itself; only the calls are reaches.
      if (typeof value !== "function" || /^[A-Z]/.test(key)) continue;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        report(`${name}.${key}`);
        return (value as (...a: unknown[]) => unknown).apply(this, args);
      };
      if (name === "os") (os as unknown as Record<string, unknown>)[key] = wrapped;
      else mod[key] = wrapped;
    }
  }
  // Named ESM imports of the builtins are bound at link time; this re-points them at the wrappers.
  syncBuiltinESMExports();
}
