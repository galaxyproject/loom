/**
 * The ProvenanceFs over the real file system: today's bytes for the Node
 * shells, moved here from galaxy-provenance.ts so that module imports no fs.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { randomHex } from "../../shared/random.js";
import type { ProvenanceFs, ProvenanceStat } from "./provenance-fs";

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code;

export const fileProvenanceFs: ProvenanceFs = {
  async lstat(p): Promise<ProvenanceStat | null> {
    try {
      return await fsp.lstat(p);
    } catch (err) {
      if (code(err) === "ENOENT") return null;
      throw err;
    }
  },
  lstatSync(p): ProvenanceStat | null {
    try {
      return fs.lstatSync(p);
    } catch (err) {
      if (code(err) === "ENOENT") return null;
      throw err;
    }
  },
  async mkdir(p) {
    try {
      await fsp.mkdir(p);
    } catch (err) {
      if (code(err) !== "EEXIST") throw err;
    }
  },
  readFile: (p) => fsp.readFile(p, "utf-8"),
  readFileSync: (p) => fs.readFileSync(p, "utf-8"),
  // `wx`: a planted file or symlink at the path fails the open instead of
  // being written through.
  writeExclusive: (p, text) => fsp.writeFile(p, text, { encoding: "utf-8", flag: "wx" }),
  async replace(file, text) {
    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${randomHex(6)}.tmp`,
    );
    await fsp.writeFile(temp, text, { encoding: "utf-8", flag: "wx" });
    try {
      // rename() replaces a symlink at the target rather than following it, and
      // readers see the old record or the new one, never half of either.
      await fsp.rename(temp, file);
    } catch (err) {
      await fsp.rm(temp, { force: true });
      throw err;
    }
  },
  readdir: (dir) => fsp.readdir(dir),
};
