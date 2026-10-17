/**
 * The byte layer under galaxy-provenance.ts: exactly the file operations the
 * provenance records and the reconcile cursor make, so a shell with no
 * directory beside its notebook can keep them somewhere else. The ownership,
 * symlink and validation logic stays in galaxy-provenance.ts; a backend only
 * stores bytes.
 *
 * Types only, no Node imports: the browser's conformance test counts Node
 * edges, and this file sits in every backend's import graph.
 */

export interface ProvenanceStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ProvenanceFs {
  /** Of the entry itself (a symlink reports as one); null when absent. */
  lstat(p: string): Promise<ProvenanceStat | null>;
  lstatSync(p: string): ProvenanceStat | null;
  /** One level; an existing directory is not an error. */
  mkdir(p: string): Promise<void>;
  readFile(p: string): Promise<string>;
  readFileSync(p: string): string;
  /** Create, never overwrite: rejects with { code: "EEXIST" } when p exists, a planted symlink included. */
  writeExclusive(p: string, text: string): Promise<void>;
  /** Create or replace so a reader sees the old text or the new, never half of either. */
  replace(p: string, text: string): Promise<void>;
  /** Entry names directly under dir. */
  readdir(dir: string): Promise<string[]>;
}
