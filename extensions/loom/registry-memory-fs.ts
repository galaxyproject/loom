/**
 * A RegistryFs over a Map, for a shell with no `.loom/state` to write: the
 * browser worker is the only writer, so the lock protocol runs unopposed on it.
 *
 * No Node imports here: this file sits outside registry.ts's import graph and
 * the browser's conformance test counts Node edges.
 */

import type { RegistryFs } from "./registry-lock";

export function memoryRegistryFs(
  files = new Map<string, string>(),
): RegistryFs & { files: Map<string, string> } {
  const dirs = new Set<string>();
  // The store reads `err.code` the way it reads Node's, so the codes match.
  const errno = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      const text = files.get(p);
      if (text === undefined) throw errno("ENOENT", p);
      return text;
    },
    writeFileSync: (p, data, options) => {
      if (options?.flag === "wx" && files.has(p)) throw errno("EEXIST", p);
      files.set(p, data);
    },
    renameSync: (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw errno("ENOENT", from);
      files.delete(from);
      files.set(to, text);
    },
    mkdirSync: (p) => {
      dirs.add(p);
    },
    unlinkSync: (p) => {
      if (!files.delete(p)) throw errno("ENOENT", p);
    },
  };
}
