/**
 * Read-only file surface for the web shell.
 *
 * The desktop answers `files:list` / `files:read` from the main process, whose
 * only client is a preload-bridged renderer in the same process tree. Here the
 * client is a browser on the other end of a socket, so the same two calls are a
 * network surface onto the analysis directory and the jail is most of the work:
 * every path is clamped to the session cwd by path math, then resolved through
 * `realpath` so a symlink cannot step outside it, and refused outright when it
 * names a dotfile, one of the directories the desktop tree hides, or something
 * the agent's own sensitive-path policy will not let the model read.
 *
 * `files:write` is deliberately not here. The desktop has it; there is no reason
 * to put a writer on a socket for a pane that only displays.
 *
 * Response shapes match `OrbitAPI.listFiles` / `OrbitAPI.readFile` exactly, with
 * one substitution: `bytes` travels as base64 in `bytesBase64` because the
 * transport is JSON. `web/files-wire.ts` turns it back into the `Uint8Array` the
 * renderer is typed against.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

import type { FileNode } from "../app/src/preload/preload.js";
import { isTextLikeForPreview } from "../app/src/main/file-preview-classification.js";
import { isSensitivePath } from "../extensions/loom/exec-guard/sensitive-read.js";

// Mirrors files-handler.ts. Kept in step by hand because that module imports
// `electron` at the top level, which cannot be loaded from here or from a test.
const MAX_DEPTH = 8;
const MAX_ENTRIES_PER_DIR = 2000;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 1024 * 1024 * 1024;
const PREVIEW_LINE_COUNT = 10;
const PREVIEW_BYTE_BUDGET = 64 * 1024;
const TAIL_LINE_COUNT = 200;
/**
 * The notebook is markdown a person reads; the shells already refuse a layout
 * file past 256 KB and a notebook is the same order of thing. Generous enough
 * that no real analysis hits it, small enough that a socket cannot be used to
 * pull an arbitrary-sized file through this channel.
 */
const MAX_NOTEBOOK_BYTES = 8 * 1024 * 1024;
const NOTEBOOK_FILENAME = "notebook.md";

/**
 * A whole-tree ceiling the desktop does not have. Its per-directory cap still
 * allows 2000 entries at each of eight levels, which is a fine amount of work
 * for a local IPC call and a bad amount of JSON to push down a socket.
 */
const MAX_TOTAL_ENTRIES = 20000;

/**
 * Total path text the listing may emit. See `WalkBudget.bytes`: the entry
 * ceiling bounds the work, this bounds the response. Two megabytes of paths is
 * far more tree than anyone reads and two orders of magnitude under what one
 * self-referential symlink produced without it.
 */
const MAX_PATH_BYTES = 2 * 1024 * 1024;

/**
 * The non-hidden names files-handler.ts's FS_BLOCKLIST drops. The dotted ones it
 * also lists are covered by the blanket dotfile rule below, so only these three
 * need naming.
 */
const NOISE_DIRS = new Set(["node_modules", "venv", "__pycache__"]);

export interface FilesSurfaceOptions {
  /**
   * LOOM_MODE=remote. The container deployment curates the filesystem away
   * entirely -- the brain's read tool is pinned to notebook.md and bash/ls/find
   * are blocked -- so the shell must not hand the browser a wider view than the
   * agent running beside it has.
   */
  remote?: boolean;
  /** $HOME for the sensitive-path policy. Injectable so a test does not depend on the runner's. */
  home?: string;
  /** Whole-tree entry ceiling. Defaults to MAX_TOTAL_ENTRIES. */
  maxEntries?: number;
  /** Per-directory entry ceiling. Defaults to MAX_ENTRIES_PER_DIR. */
  maxEntriesPerDir?: number;
  /** Whole-tree path-text ceiling. Defaults to MAX_PATH_BYTES. */
  maxPathBytes?: number;
}

export type WebFileReadResult =
  | {
      ok: true;
      size: number;
      bytesBase64: string;
      preview?: { kind: "head"; lineCount: number; byteBudgetHit: boolean };
    }
  | { ok: false; error: string; size?: number };

export type WebFileListResult =
  { ok: true; root: FileNode; cwd: string } | { ok: false; error: string };

export type JailResult = { ok: true; abs: string; rel: string } | { ok: false; error: string };

const REMOTE_LIST_REFUSAL = "file listing is unavailable in remote mode";
const REMOTE_READ_REFUSAL = "file read is unavailable in remote mode";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Why this segment may not appear in a path the browser asked for, or null when
 * it may. Applied to every segment of the clamped relative path, and again to
 * the relative real path once symlinks are collapsed, so a benign-looking name
 * pointing at `.env` is refused on the target rather than on the link.
 */
function segmentRefusal(segment: string): string | null {
  if (segment === "" || segment === ".") return null;
  if (segment === "..") return "path leaves the working directory";
  if (segment.startsWith(".")) return "hidden files are not served";
  // Case-folded, for the reason exec-guard/path-jail.ts folds: a case-insensitive
  // filesystem makes `Node_Modules` the same directory. The real-path re-check
  // below catches it on macOS, where realpath canonicalizes case, but Linux's
  // does not and a caller could use this helper without the re-check.
  if (NOISE_DIRS.has(segment.toLowerCase())) return "that directory is not served";
  return null;
}

function pathRefusal(rel: string, abs: string, home: string): string | null {
  for (const segment of rel.split(path.sep)) {
    const refusal = segmentRefusal(segment);
    if (refusal) return refusal;
  }
  // The agent is refused these outright inside the workspace; a socket should
  // not be a way around that.
  if (isSensitivePath(abs, home)) return "that file matches the sensitive-path policy";
  return null;
}

/**
 * Clamp a browser-supplied path to the session cwd. Pure: string and path math
 * only, so the whole refusal table is testable without a filesystem. The
 * symlink question is separate and needs `realpath` -- see `resolveRealWithin`.
 */
export function resolveInJail(
  cwd: string,
  relPath: unknown,
  options: FilesSurfaceOptions = {},
): JailResult {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    return { ok: false, error: "a file path is required" };
  }
  // A NUL truncates the path at the syscall boundary, so `notebook.md\0.png`
  // would pass an extension check and open something else.
  if (relPath.includes("\0")) return { ok: false, error: "invalid file path" };
  // path.isAbsolute is posix-only on posix, so name the Windows forms too --
  // this server is the same code on either platform.
  if (path.isAbsolute(relPath) || /^[/\\]/.test(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    return { ok: false, error: "absolute paths are not served" };
  }

  const abs = path.resolve(cwd, path.normalize(relPath));
  const rel = path.relative(cwd, abs);
  // `startsWith("..")` -- the usual spelling, and the one files-handler.ts uses
  // -- also catches a file legitimately named `..notes`. path.relative only ever
  // emits `..` as a whole segment, so compare it as one.
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return { ok: false, error: "path leaves the working directory" };
  }

  const refusal = pathRefusal(rel, abs, options.home ?? homedir());
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, abs, rel: toPosix(rel) };
}

/**
 * Is `real` the cwd or inside it?
 *
 * Spelled out rather than `startsWith(cwdReal + path.sep)` because that becomes
 * `startsWith("//")` when the cwd is the filesystem root, which matches nothing
 * -- with cwd at `/`, a listing came back holding one entry. It failed safe, and
 * a cwd at `/` is pathological, but the check was simply wrong there.
 */
function isWithinCwd(real: string, cwdReal: string): boolean {
  if (real === cwdReal) return true;
  const prefix = cwdReal.endsWith(path.sep) ? cwdReal : cwdReal + path.sep;
  return real.startsWith(prefix);
}

/**
 * The half of the jail that needs the disk: the target's real path has to stay
 * inside the cwd's real path, and the policy above has to hold for the real name
 * too. Throws nothing -- an ELOOP from a symlink cycle or an ENOENT comes back
 * as a refusal.
 */
async function resolveRealWithin(
  cwd: string,
  abs: string,
  home: string,
): Promise<{ ok: true; real: string } | { ok: false; error: string }> {
  let cwdReal: string;
  let real: string;
  try {
    cwdReal = await fsp.realpath(cwd);
  } catch {
    return { ok: false, error: "the working directory is not readable" };
  }
  try {
    real = await fsp.realpath(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP") return { ok: false, error: "path leaves the working directory" };
    return { ok: false, error: "no such file" };
  }
  if (!isWithinCwd(real, cwdReal)) {
    return { ok: false, error: "path leaves the working directory" };
  }
  const refusal = pathRefusal(path.relative(cwdReal, real), real, home);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, real };
}

/**
 * Where a symlink actually lands, or null when the tree should not show it at
 * all: outside the jail, unresolvable, or onto a name the read side refuses.
 * Listing such an entry discloses the name and size of something the caller may
 * not read, and offers a click that can only fail.
 */
async function linkTarget(cwdReal: string, abs: string, home: string): Promise<string | null> {
  let real: string;
  try {
    real = await fsp.realpath(abs);
  } catch {
    return null;
  }
  if (!isWithinCwd(real, cwdReal)) return null;
  if (pathRefusal(path.relative(cwdReal, real), real, home)) return null;
  return real;
}

interface WalkBudget {
  /** Entries left to examine across the whole tree. Refused entries count. */
  remaining: number;
  /** Entries to examine in any one directory. */
  perDir: number;
  /**
   * Bytes of path text left to emit.
   *
   * The entry ceiling bounds the work and not the answer, and those are not
   * the same dimension: every node carries a `relPath` whose length grows with
   * depth times name length, so one symlink to the cwd named with 180
   * characters turned a nine-file directory into 13.8 MB of JSON down the
   * socket -- roughly 40 MB with a 255-character name. Charging for the path
   * text bounds what actually crosses the wire.
   */
  bytes: number;
}

async function walkDir(
  cwd: string,
  cwdReal: string,
  relDir: string,
  depth: number,
  home: string,
  budget: WalkBudget,
): Promise<FileNode[]> {
  if (depth > MAX_DEPTH || budget.remaining <= 0 || budget.bytes <= 0) return [];
  const absDir = path.resolve(cwd, relDir);

  // `opendir` rather than `readdir`: readdir materializes the whole directory
  // before any cap applies, so a million-entry directory is a memory spike that
  // the per-directory cap does not prevent. Streaming means the cap is a real
  // ceiling on work, not just on what comes back.
  let dir: fs.Dir;
  try {
    dir = await fsp.opendir(absDir);
  } catch {
    return [];
  }

  const out: FileNode[] = [];
  let seen = 0;
  for await (const e of dir) {
    if (seen >= budget.perDir || budget.remaining <= 0) break;
    seen++;
    // Refused entries cost budget too. Otherwise a directory of ten thousand
    // dotfiles is ten thousand free checks at every level of the tree.
    budget.remaining--;
    const absPath = path.join(absDir, e.name);
    // Same table the read path uses, so the tree never shows something a click
    // would then be refused.
    if (segmentRefusal(e.name) || isSensitivePath(absPath, home)) continue;

    const childRel = toPosix(path.join(relDir, e.name));
    budget.bytes -= childRel.length + e.name.length;
    if (budget.bytes <= 0) break;

    let isDir = e.isDirectory();
    let isFile = e.isFile();
    let recurse = isDir;
    if (e.isSymbolicLink()) {
      const target = await linkTarget(cwdReal, absPath, home);
      if (!target) continue;
      try {
        const stat = await fsp.stat(absPath);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
        // Show it, but do not walk back up through it. A link pointing at the
        // cwd or at any directory above it re-lists the whole tree under a new
        // name, once per level, which is legal and inside the jail and still
        // nonsense: a four-file analysis reported 376 results, the same plots
        // over and over, because `figures/` was reachable by several paths.
        // The byte budget bounds what that costs; this stops it happening.
        const absReal = await fsp.realpath(absDir).catch(() => absDir);
        recurse = isDir && !isWithinCwd(absReal, target);
      } catch {
        continue;
      }
    }

    if (isDir) {
      out.push({
        name: e.name,
        relPath: childRel,
        type: "directory",
        children: recurse ? await walkDir(cwd, cwdReal, childRel, depth + 1, home, budget) : [],
      });
    } else if (isFile) {
      let size: number | undefined;
      try {
        size = (await fsp.stat(absPath)).size;
      } catch {
        size = undefined;
      }
      out.push({ name: e.name, relPath: childRel, type: "file", size });
    }
    // Sockets / fifos / devices stay out, as on the desktop.
  }

  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * `files:list`. The desktop takes `includeHidden` from a sidebar toggle; this
 * surface ignores it and never serves hidden entries, because the read side
 * refuses them and a tree you cannot open is worse than a tree that is honest
 * about what it shows.
 */
export async function listFilesForWeb(
  cwd: string,
  options: FilesSurfaceOptions = {},
): Promise<WebFileListResult> {
  if (options.remote) return { ok: false, error: REMOTE_LIST_REFUSAL };
  const home = options.home ?? homedir();
  try {
    // Symlink targets are compared against the cwd's own real path, so resolve
    // it once rather than per entry.
    const cwdReal = await fsp.realpath(cwd).catch(() => path.resolve(cwd));
    const children = await walkDir(cwd, cwdReal, "", 0, home, {
      remaining: options.maxEntries ?? MAX_TOTAL_ENTRIES,
      perDir: options.maxEntriesPerDir ?? MAX_ENTRIES_PER_DIR,
      bytes: options.maxPathBytes ?? MAX_PATH_BYTES,
    });
    return {
      ok: true,
      root: { name: path.basename(cwd) || cwd, relPath: "", type: "directory", children },
      cwd,
    };
  } catch {
    return { ok: false, error: "the working directory could not be listed" };
  }
}

/**
 * Open a validated path and prove the descriptor is the file that was
 * validated.
 *
 * `resolveRealWithin` answers a question about a *pathname*, and every
 * subsequent `stat`/`open`/`readFile` on that pathname asks the kernel to walk
 * it again. Between the two walks the agent -- which can write in this
 * directory -- can swap a component for a symlink pointing outside, and the
 * second walk follows it. That is not theoretical: racing a rename of the
 * resolved parent directory against this function's previous shape leaked
 * outside bytes on 46 of 6000 reads.
 *
 * So the pathname is walked exactly once more, here, and everything after that
 * goes through the descriptor:
 *
 *  - `O_NOFOLLOW` (where the platform has it) makes the open fail outright if
 *    the final component became a symlink;
 *  - the descriptor's own `fstat` is compared with an `lstat` of the validated
 *    path, so a swapped *parent* is caught whether the swap is still in place
 *    (the paths disagree) or has been reverted (the inodes disagree);
 *  - the path is re-resolved and re-checked against the jail, so a swap that is
 *    still in place cannot pass on inode identity alone.
 *
 * **This is a mitigation, not a proof, and the limit is the runtime's.** Closing
 * the class outright needs `openat`, so that the path is walked once and every
 * later operation goes through a descriptor. Node exposes no `openat`, and the
 * usual stand-ins do not work: `/proc/self/fd/N/child` is Linux-only and
 * `/dev/fd/N/child` does not resolve on macOS (checked, ENOENT). With the swap
 * running at full duty cycle under load, roughly one read in 400 still slips
 * through here, down from one in 15. A symlink planted and left -- which is the
 * shape a prompt-injected agent's attack actually has -- is refused every time,
 * and that is what the deterministic tests cover.
 *
 * The caller must close the handle.
 */
async function openVerified(
  cwd: string,
  real: string,
  home: string,
): Promise<
  | { ok: true; fd: fsp.FileHandle; size: number; verify: () => Promise<boolean> }
  | { ok: false; error: string }
> {
  // The identity the jail approves, captured BEFORE the open and never
  // re-derived from the path afterwards. That ordering is the whole fix: an
  // `lstat` taken after the open walks the path again and can be raced into
  // agreeing with a descriptor that points outside -- I watched exactly that
  // happen, twice in 800 reads, with a post-open comparison in place.
  let approved: fs.Stats;
  try {
    approved = await fsp.lstat(real);
    if (approved.isSymbolicLink()) {
      return { ok: false, error: "path leaves the working directory" };
    }
    // Re-resolve between the two reads of the name: a swap that was in place
    // when the identity was captured shows up here as a path that no longer
    // lands where the jail said it did.
    const between = await resolveRealWithin(cwd, real, home);
    if (!between.ok || between.real !== real) {
      return { ok: false, error: "path leaves the working directory" };
    }
    const confirm = await fsp.lstat(real);
    if (confirm.ino !== approved.ino || confirm.dev !== approved.dev) {
      return { ok: false, error: "the file changed while it was being read" };
    }
  } catch {
    return { ok: false, error: "the file could not be read" };
  }

  // O_NOFOLLOW is POSIX; on Windows the constant is absent and the open is a
  // plain read, which is the best that platform offers here.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: fsp.FileHandle;
  try {
    fd = await fsp.open(real, flags);
  } catch {
    // ELOOP here is the attack being refused rather than succeeding.
    return { ok: false, error: "the file could not be read" };
  }

  /**
   * Is this descriptor the file the jail approved?
   *
   * A descriptor cannot change identity once opened, so comparing its `fstat`
   * against the inode captured above settles it -- if the open walked through a
   * swapped parent it landed on a different inode and this refuses. On Linux
   * the kernel will also name the descriptor's own path through procfs, which
   * nothing in the directory tree can spoof, so there the answer is exact.
   */
  const verify = async (): Promise<boolean> => {
    try {
      const st = await fd.stat();
      if (st.ino !== approved.ino || st.dev !== approved.dev) return false;
      const exact = await fdRealPath(fd);
      if (exact !== null) return withinJail(exact, await fsp.realpath(cwd), home);
      return true;
    } catch {
      return false;
    }
  };

  try {
    const st = await fd.stat();
    if (!st.isFile()) {
      await fd.close();
      return { ok: false, error: "Not a regular file" };
    }
    if (!(await verify())) {
      await fd.close();
      return { ok: false, error: "path leaves the working directory" };
    }
    return { ok: true, fd, size: st.size, verify };
  } catch {
    await fd.close().catch(() => {});
    return { ok: false, error: "the file could not be read" };
  }
}

/**
 * The path a descriptor actually refers to, or null where the platform will not
 * say. Linux exposes it through procfs; macOS needs `fcntl(F_GETPATH)`, which
 * Node does not surface, so there the caller falls back to comparing inodes.
 */
async function fdRealPath(fd: fsp.FileHandle): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    return await fsp.realpath(`/proc/self/fd/${fd.fd}`);
  } catch {
    return null;
  }
}

function withinJail(real: string, cwdReal: string, home: string): boolean {
  if (!isWithinCwd(real, cwdReal)) return false;
  return pathRefusal(path.relative(cwdReal, real), real, home) === null;
}

/** Read at most `cap` bytes through an already-verified descriptor. */
async function readCapped(fd: fsp.FileHandle, cap: number, offset = 0): Promise<Buffer> {
  const buf = Buffer.alloc(cap);
  const { bytesRead } = await fd.read(buf, 0, cap, offset);
  return buf.subarray(0, bytesRead);
}

/**
 * `notebook:load`. One fixed filename, so there is nothing to traverse with --
 * but the name can still BE a symlink, and before this went through the jail a
 * link planted at `notebook.md` returned whatever it pointed at, in remote mode
 * too. Reproduced against a credential file outside the workspace.
 *
 * Deliberately still served in remote mode, unlike `files:read`. That refusal
 * exists because `files:read` takes an arbitrary path and the container
 * deployment curates the filesystem away; `notebook.md` is the one file remote
 * mode is built around -- `web-mode-gate.ts` pins the agent's own read and write
 * tools to exactly it -- so serving it to the browser is not a wider view than
 * the agent beside it already has. What remote mode must not do is follow a link
 * out, and that is what this now refuses.
 *
 * Capped, and the cap refuses rather than truncating: a notebook is read to be
 * displayed whole, and half a notebook shown as if it were the notebook is worse
 * than an error.
 */
export async function readNotebookForWeb(
  cwd: string,
  options: FilesSurfaceOptions = {},
): Promise<{ ok: true; content: string; path: string } | { ok: false; error: string }> {
  const home = options.home ?? homedir();
  const abs = path.join(cwd, NOTEBOOK_FILENAME);

  const jailed = resolveInJail(cwd, NOTEBOOK_FILENAME, { home });
  if (!jailed.ok) return { ok: false, error: jailed.error };
  const real = await resolveRealWithin(cwd, jailed.abs, home);
  if (!real.ok) return { ok: false, error: real.error };

  const opened = await openVerified(cwd, real.real, home);
  if (!opened.ok) return { ok: false, error: opened.error };
  const { fd, size, verify } = opened;
  try {
    if (size > MAX_NOTEBOOK_BYTES) {
      return { ok: false, error: `notebook.md is larger than ${MAX_NOTEBOOK_BYTES} bytes` };
    }
    const buf = await readCapped(fd, MAX_NOTEBOOK_BYTES + 1);
    if (buf.length > MAX_NOTEBOOK_BYTES) {
      return { ok: false, error: `notebook.md is larger than ${MAX_NOTEBOOK_BYTES} bytes` };
    }
    if (!(await verify())) return { ok: false, error: "path leaves the working directory" };
    return { ok: true, content: buf.toString("utf-8"), path: abs };
  } catch {
    return { ok: false, error: "the notebook could not be read" };
  } finally {
    await fd.close().catch(() => {});
  }
}

/**
 * `files:read`. Byte budgets and the tail/head preview behaviour are the
 * desktop's; the jail, and a fixed message for anything unexpected, are this
 * surface's. An `err.message` from fs names the absolute path it failed on, so
 * none of them cross.
 */
export async function readFileForWeb(
  cwd: string,
  relPath: unknown,
  opts?: { tail?: boolean } | null,
  options: FilesSurfaceOptions = {},
): Promise<WebFileReadResult> {
  if (options.remote) return { ok: false, error: REMOTE_READ_REFUSAL };
  const home = options.home ?? homedir();

  const jailed = resolveInJail(cwd, relPath, { home });
  if (!jailed.ok) return jailed;
  const real = await resolveRealWithin(cwd, jailed.abs, home);
  if (!real.ok) return { ok: false, error: real.error };

  const opened = await openVerified(cwd, real.real, home);
  if (!opened.ok) return { ok: false, error: opened.error };
  const { fd, size, verify } = opened;

  try {
    if (opts?.tail) {
      const readSize = Math.min(size, PREVIEW_BYTE_BUDGET);
      const offset = size - readSize;
      const tail = await readCapped(fd, readSize, offset);
      const lines = tail.toString("utf-8").split("\n");
      // A non-zero offset means the first element is half a line (or half a
      // multibyte character); drop it rather than ship a fragment.
      if (offset > 0 && lines.length > 1) lines.shift();
      if (!(await verify())) return { ok: false, error: "path leaves the working directory" };
      return {
        ok: true,
        size,
        bytesBase64: Buffer.from(lines.slice(-TAIL_LINE_COUNT).join("\n"), "utf-8").toString(
          "base64",
        ),
      };
    }

    if (size <= MAX_READ_BYTES) {
      // Capped by what comes back, not by the size the stat reported: a file
      // that grows between the two would otherwise be served whole.
      const buf = await readCapped(fd, MAX_READ_BYTES + 1);
      if (buf.length > MAX_READ_BYTES) {
        return {
          ok: false,
          error: `File too large (limit ${MAX_READ_BYTES})`,
          size: buf.length,
        };
      }
      if (!(await verify())) return { ok: false, error: "path leaves the working directory" };
      return { ok: true, size: buf.length, bytesBase64: buf.toString("base64") };
    }

    if (size > MAX_PREVIEW_BYTES) {
      return {
        ok: false,
        error: `File too large (${size} bytes, hard limit ${MAX_PREVIEW_BYTES})`,
        size,
      };
    }

    if (!isTextLikeForPreview(path.basename(real.real))) {
      return {
        ok: false,
        error: `File too large (${size} bytes, limit ${MAX_READ_BYTES})`,
        size,
      };
    }

    const head = await readCapped(fd, PREVIEW_BYTE_BUDGET);
    const lines = head.toString("utf-8").split("\n").slice(0, PREVIEW_LINE_COUNT);
    if (!(await verify())) return { ok: false, error: "path leaves the working directory" };
    return {
      ok: true,
      size,
      bytesBase64: Buffer.from(lines.join("\n"), "utf-8").toString("base64"),
      preview: {
        kind: "head",
        lineCount: lines.length,
        byteBudgetHit: head.length === PREVIEW_BYTE_BUDGET && lines.length < PREVIEW_LINE_COUNT,
      },
    };
  } catch {
    return { ok: false, error: "the file could not be read" };
  } finally {
    await fd.close().catch(() => {});
  }
}
