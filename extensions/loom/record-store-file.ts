/**
 * The file backend of the record store: `notebook.md` on disk, written
 * atomically, versioned by a stat fingerprint, watched by chokidar.
 *
 * This is the only record module with fs/chokidar edges; record-store.ts
 * resolves to it for every key the shell has not claimed.
 */

import { randomBytes } from "crypto";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { NotebookChangedError, type RecordStore, type RecordVersion } from "./record-store";

// Per-write scratch name. A fixed `<file>.tmp` is shared by every writer, so
// two of them (two Loom processes on one notebook, or one process that abandons
// a guarded write while another is staging one) can overwrite or delete each
// other's staging file and rename the wrong bytes into place. Random names cost
// nothing and take that off the table; paired with the `wx` flag below they also
// mean we never write through a path someone else got to first.
function tmpPathFor(filePath: string): string {
  return `${filePath}.tmp.${randomBytes(8).toString("hex")}`;
}

// Windows refuses to replace a file another rename (or a scanner) is touching
// at that instant, with EPERM/EACCES/EBUSY, where POSIX would just swap it in.
// Retrying briefly gives the same last-writer-wins outcome POSIX gets.
async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (process.platform !== "win32" || !transient || attempt >= 10) {
        await fs.rm(from, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
    }
  }
}

export function createFileRecordStore(filePath: string): RecordStore {
  const subscribers = new Set<(content: string) => void>();
  let watcher: FSWatcher | null = null;

  // Include dev/ino and ctimeMs, not just mtime+size: an atomic temp-and-rename
  // save swaps the inode (changing ino), and ctime moves on any write -- so an
  // inode-replacing or same-size rewrite with a preserved/coarse mtime is still
  // seen as changed. #253
  // This is the CAS key too, not only the reemit fingerprint, so a ctime-only
  // touch (chmod, utimes, a sync client tagging xattrs) between a caller's read
  // and its guarded write costs one retry of the loop rather than passing.
  async function stat(): Promise<RecordVersion | null> {
    try {
      const st = await fs.stat(filePath);
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return null;
    }
  }

  function startWatcher(): void {
    // chokidar on a missing single file never emits `change`; the after-tool
    // reemit in state.ts is the recovery path once the file appears.
    if (!existsSync(filePath)) return;
    try {
      watcher = chokidar.watch(filePath, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      });
      watcher.on("change", async () => {
        try {
          const content = await fs.readFile(filePath, "utf-8");
          for (const subscriber of [...subscribers]) subscriber(content);
        } catch (err) {
          // A file deleted between the event and the read is nothing to report.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error("notebook watcher read failed:", err);
          }
        }
      });
    } catch (err) {
      console.error("failed to start notebook watcher:", err);
    }
  }

  function stopWatcher(): void {
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }

  return {
    kind: "file",
    key: filePath,
    label: filePath,
    stat,

    async read() {
      const version = await stat();
      const content = await fs.readFile(filePath, "utf-8");
      return { content, version };
    },

    /**
     * Atomic write: render to a scratch sibling then rename. The rename is
     * atomic on POSIX, so the destination either has the old or the new
     * content -- never partial. The file watcher may still fire on the rename,
     * but it can no longer observe a half-written file.
     *
     * With `expect` (a version taken *before* the read this content was derived
     * from) the write is a compare-and-swap: if the file changed in the meantime
     * -- an agent `edit`/`bash` append, or another writer entirely -- the write
     * is abandoned with `NotebookChangedError` instead of overwriting a
     * stranger's update (#391). Callers are expected to re-read and retry.
     *
     * The check sits between the staging write and the rename, which narrows
     * the exposure to a single `rename` syscall but does not close it:
     * stat-then-rename is not atomic, and a writer that lands in that gap is
     * still overwritten. Closing it for real needs an OS-level lock (or routing
     * every notebook write through one owner), which is a bigger change than
     * #391.
     */
    async write(content, expect) {
      const tmp = tmpPathFor(filePath);
      // `wx` is O_CREAT | O_EXCL: create the scratch file or fail. Never follow
      // an existing path -- a symlink planted at a scratch name would otherwise
      // let a write land on whatever it points at.
      await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
      if (expect) {
        const current = await stat();
        if (!current || current !== expect) {
          await fs.rm(tmp, { force: true });
          throw new NotebookChangedError(filePath);
        }
      }
      await renameReplacing(tmp, filePath);
    },

    async ensure() {
      try {
        await fs.writeFile(filePath, "", { flag: "wx" });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      // `wx` refuses to follow a symlink, so a notebook.md that links to a
      // not-yet-created target reads as EEXIST here while stat() says absent.
      // Creating through the link keeps that layout working as the old
      // existsSync + writeFileSync did.
      if ((await stat()) !== null) return false;
      const link = await fs.lstat(filePath).catch(() => null);
      if (!link?.isSymbolicLink()) return false;
      await fs.writeFile(filePath, "", { flag: "w" });
      return true;
    },

    onChange(cb) {
      subscribers.add(cb);
      if (subscribers.size === 1) startWatcher();
      return () => {
        if (!subscribers.delete(cb)) return;
        if (subscribers.size === 0) stopWatcher();
      };
    },
  };
}
