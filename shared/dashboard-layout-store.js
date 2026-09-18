/**
 * The layout file, read and written the same way by everything that touches it.
 *
 * Three processes write `.loom-dashboard.json`: the Electron main process on the
 * renderer's behalf, the web server on the browser's behalf, and the brain. Each
 * had its own copy of "lstat, read, compare the revision, stage a temp file,
 * rename", and hand-mirrored copies drift -- one of them followed a dangling
 * symlink the others refused, and none of them was a compare-and-swap.
 *
 * It was not a compare-and-swap because the check and the rename were separated
 * by an `await`. Two saves based on the same revision both passed the check and
 * both reported success, and the second silently replaced the first: reproduced
 * three times out of three against a real directory. Serializing per path inside
 * the process and re-checking immediately before the rename closes that.
 *
 * **The serialization is per process.** Two different processes writing the same
 * file still race, and the remaining window is one syscall wide -- the check
 * sits immediately before the rename with nothing awaited in between. Closing it
 * across processes needs a lock file, which is a bigger change than this and
 * wants its own decision; the revision is still carried end to end, so the loser
 * of a cross-process race is told, rather than silently winning.
 */

import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { dashboardRevision } from "./dashboard-contract.js";

/**
 * One promise chain per absolute path. Every save on a path queues behind the
 * previous one, so the read-check-rename below is a critical section rather
 * than three syscalls that happen to be near each other.
 */
const chains = new Map();

/** Run `fn` with nothing else on this path running at the same time. */
export function withLayoutLock(absPath, fn) {
  const key = path.resolve(absPath);
  const previous = chains.get(key) ?? Promise.resolve();
  // Settle either way: one caller's failure must not wedge the queue behind it.
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => {},
    () => {},
  );
  chains.set(key, settled);
  // Drop the entry once nothing is waiting, so a long session switching
  // analysis directories does not accumulate one chain per directory.
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

/** For tests: is anything queued? */
export function layoutLockIdle() {
  return chains.size === 0;
}

/**
 * Read the layout file.
 *
 * `lstat` first, and on the link itself rather than its target: a dangling
 * symlink has to read as "there is a symlink here", not as "there is no file
 * here". The web shell used `existsSync`, which follows the link and therefore
 * called a dangling one absent -- so it then replaced it while the desktop
 * refused, which is the drift this module exists to end.
 */
export async function readLayoutFile(absPath, maxBytes) {
  let stat;
  try {
    stat = await fsp.lstat(absPath);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, raw: null, revision: null };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, error: `${path.basename(absPath)} is a symlink; refusing to read` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `${path.basename(absPath)} is not a regular file` };
  }
  // Checked before the read, so an oversized file is never pulled into memory --
  // it used to come back whole inside a conflict response.
  if (stat.size > maxBytes) {
    return { ok: false, error: `dashboard layout is larger than ${maxBytes} bytes` };
  }
  try {
    const raw = await fsp.readFile(absPath, "utf8");
    return { ok: true, raw, revision: dashboardRevision(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Replace the layout file if it still has the revision the caller based its
 * change on.
 *
 * `baseRevision === undefined` means an unconditional write -- the escape hatch
 * for a reset over a file nothing can parse. `null` means "there should be no
 * file yet" and is checked like any other revision.
 */
export async function casWriteLayoutFile(absPath, raw, baseRevision, maxBytes) {
  if (typeof raw !== "string") return { ok: false, error: "expected dashboard JSON text" };
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, error: `dashboard layout is larger than ${maxBytes} bytes` };
  }

  return withLayoutLock(absPath, async () => {
    const current = await readLayoutFile(absPath, maxBytes);
    if (!current.ok) return current;
    if (baseRevision !== undefined && baseRevision !== current.revision) {
      return {
        ok: false,
        conflict: true,
        error: "the dashboard changed on disk since it was loaded",
        raw: current.raw,
        revision: current.revision,
      };
    }

    // Stage first, then re-check, then rename with nothing awaited in between.
    // The scratch name is random and the write is `wx` (O_CREAT | O_EXCL) for
    // the same reason the real name is lstat'd: the agent can write in this
    // directory, and a guessable scratch name is a second place to plant a
    // symlink that the following write would go through.
    const tmp = `${absPath}.tmp.${randomBytes(8).toString("hex")}`;
    try {
      await fsp.writeFile(tmp, raw, { encoding: "utf8", flag: "wx" });
      const before = await readLayoutFile(absPath, maxBytes);
      if (!before.ok) {
        await fsp.rm(tmp, { force: true });
        return before;
      }
      if (baseRevision !== undefined && baseRevision !== before.revision) {
        await fsp.rm(tmp, { force: true });
        return {
          ok: false,
          conflict: true,
          error: "the dashboard changed on disk since it was loaded",
          raw: before.raw,
          revision: before.revision,
        };
      }
      await fsp.rename(tmp, absPath);
      return { ok: true, revision: dashboardRevision(raw) };
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
