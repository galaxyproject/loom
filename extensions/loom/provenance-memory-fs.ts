/**
 * A ProvenanceFs over a Map, for a shell with no directory beside its
 * notebook: the browser worker keeps attempt records and the reconcile cursor
 * for the life of the process. The paths carry the analysis dir, so two
 * records hosted by one worker keep separate provenance on the one Map.
 *
 * No Node imports here: the browser's conformance test counts Node edges.
 */

import type { ProvenanceFs, ProvenanceStat } from "./provenance-fs";

const stat = (kind: "file" | "dir"): ProvenanceStat => ({
  isFile: () => kind === "file",
  isDirectory: () => kind === "dir",
  isSymbolicLink: () => false,
});

// Exactly one separator and one name past the directory.
const CHILD = /^[\\/][^\\/]+$/;

export function memoryProvenanceFs(
  files = new Map<string, string>(),
): ProvenanceFs & { files: Map<string, string> } {
  const dirs = new Set<string>();
  // galaxy-provenance.ts reads `err.code` the way it reads Node's, so the codes match.
  const errno = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  const lstatSync = (p: string) => (files.has(p) ? stat("file") : dirs.has(p) ? stat("dir") : null);
  const readFileSync = (p: string) => {
    const text = files.get(p);
    if (text === undefined) throw errno("ENOENT", p);
    return text;
  };
  return {
    files,
    lstat: async (p) => lstatSync(p),
    lstatSync,
    mkdir: async (p) => {
      dirs.add(p);
    },
    readFile: async (p) => readFileSync(p),
    readFileSync,
    writeExclusive: async (p, text) => {
      if (files.has(p)) throw errno("EEXIST", p);
      files.set(p, text);
    },
    replace: async (p, text) => {
      files.set(p, text);
    },
    readdir: async (dir) => {
      const names: string[] = [];
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(dir)) continue;
        const rest = key.slice(dir.length);
        if (CHILD.test(rest)) names.push(rest.slice(1));
      }
      return names;
    },
  };
}
