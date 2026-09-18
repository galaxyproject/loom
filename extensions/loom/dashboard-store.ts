/**
 * Brain-side access to the dashboard layout file.
 *
 * The layout is `.loom-dashboard.json` beside `notebook.md` in the analysis
 * directory. The shells already read and write it -- the desktop through its
 * cwd watcher, both shells through a revision poll -- so a write here IS the
 * transport: there is no second channel and no widget push for layout. The
 * brain writes the file; whichever shell is attached picks it up within a few
 * seconds. In the CLI nothing is attached and the file is simply updated.
 *
 * Three writers share this file (the pane's editor, a widget saving its own
 * config, and this module), which is why every write is a compare-and-swap on
 * the shared content revision and lands through a temp file plus rename. Same
 * discipline as `writeNotebook`/`withNotebookCas`, same reasons.
 */

import { randomBytes } from "node:crypto";
import { withLayoutLock } from "../../shared/dashboard-layout-store.js";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  DASHBOARD_FILENAME,
  DASHBOARD_MAX_BYTES,
  createDefaultDashboardDocument,
  dashboardRevision,
  parseDashboardDocument,
  serializeDashboardDocument,
} from "../../shared/dashboard-contract.js";
import type { DashboardDocument, DashboardProblem } from "../../shared/dashboard-contract.js";
import { getNotebookPath } from "./state";

/** How many read-apply-write attempts before giving up to a concurrent writer. */
const MAX_CAS_ATTEMPTS = 3;

/** Undo depth. Layout documents are small; this costs nothing worth counting. */
const MAX_UNDO_DEPTH = 10;

export type DashboardStoreFailure = { ok: false; error: string };

export type DashboardReadResult =
  | {
      ok: true;
      /** The validated document -- the default one when there is no file yet. */
      document: DashboardDocument;
      /** False when nothing is on disk, so the caller can say "default layout". */
      exists: boolean;
      /** Repairs validation made, or why an unreadable file was ignored. */
      problems: DashboardProblem[];
      /** Content fingerprint of what was on disk, null when there was no file. */
      revision: string | null;
      /** Exactly what was on disk, null when there was no file. */
      raw: string | null;
      path: string;
    }
  | DashboardStoreFailure;

export type DashboardWriteResult =
  { ok: true; document: DashboardDocument; path: string; revision: string } | DashboardStoreFailure;

/**
 * Where the layout lives for this session. Derived from the notebook path, not
 * from a caller argument and not from `process.cwd()`: the notebook is what
 * defines "the analysis directory" brain-side, and a fixed basename under it
 * means no tool input ever reaches a filesystem path.
 */
export function getDashboardPath(): string | null {
  const notebook = getNotebookPath();
  if (!notebook) return null;
  return path.join(path.dirname(notebook), DASHBOARD_FILENAME);
}

const CHANGED_SINCE =
  "The dashboard has changed since that edit, so undoing it would discard the newer layout. Nothing was changed.";

const NO_SESSION =
  "No analysis directory yet -- the dashboard file lives beside notebook.md, and this session has no notebook.";

/**
 * Refuse a symlink at the layout path, on read and on write.
 *
 * The basename is fixed so there is nothing to traverse with, but the agent can
 * write in the analysis directory and `writeFile` follows symlinks, so a link
 * planted at this name would turn a background layout save into a write to
 * whatever it points at.
 */
async function refuseSymlink(filePath: string, checkSize = true): Promise<string | null> {
  try {
    const st = await fsp.lstat(filePath);
    if (st.isSymbolicLink()) {
      return `${DASHBOARD_FILENAME} is a symbolic link; refusing to read or write through it.`;
    }
    if (checkSize && st.isFile() && st.size > DASHBOARD_MAX_BYTES) {
      return `${DASHBOARD_FILENAME} is larger than ${DASHBOARD_MAX_BYTES} bytes; refusing to read it. /dashboard reset will replace it.`;
    }
  } catch {
    // Missing is fine -- that is the no-file-yet case.
  }
  return null;
}

/**
 * The file's text, or null when there is genuinely no file.
 *
 * Only ENOENT counts as "no file". Swallowing every error would turn an
 * unreadable layout -- a permissions problem, a directory left at that name --
 * into "there is nothing here", and the compare-and-swap below would then
 * happily rename over something it could not read.
 */
async function readRaw(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Describe a filesystem failure without the filesystem's own words.
 *
 * An errno message carries the absolute path, and for a failed rename it also
 * carries the scratch filename, which is the one thing about this writer worth
 * keeping to ourselves. Every other message here names only the basename; these
 * should too.
 */
function fsFailure(verb: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return `Could not ${verb} ${DASHBOARD_FILENAME}${code ? ` (${code})` : ""}.`;
}

/** Read and validate the layout, falling back to the default document. */
export async function readDashboardDocument(): Promise<DashboardReadResult> {
  const filePath = getDashboardPath();
  if (!filePath) return { ok: false, error: NO_SESSION };

  const refusal = await refuseSymlink(filePath);
  if (refusal) return { ok: false, error: refusal };

  let raw: string | null;
  try {
    raw = await readRaw(filePath);
  } catch (err) {
    return { ok: false, error: fsFailure("read", err) };
  }
  if (raw === null) {
    return {
      ok: true,
      document: createDefaultDashboardDocument(),
      exists: false,
      problems: [],
      revision: null,
      raw: null,
      path: filePath,
    };
  }

  const parsed = parseDashboardDocument(raw);
  if (!parsed.ok) {
    // Matches the shells: an unreadable layout is left on disk exactly as it is
    // and the default is shown, because losing someone's layout to a parse bug
    // is worse than one session of the default.
    return {
      ok: true,
      document: createDefaultDashboardDocument(),
      exists: true,
      problems: parsed.problems,
      revision: dashboardRevision(raw),
      raw,
      path: filePath,
    };
  }
  return {
    ok: true,
    document: parsed.document,
    exists: true,
    problems: parsed.problems,
    revision: dashboardRevision(raw),
    raw,
    path: filePath,
  };
}

/**
 * One entry per write this process made, newest last.
 *
 * `previous: null` means "there was no file", so undoing back to that state
 * removes the one we created rather than leaving a layout nobody asked for.
 * `wrote` and `path` are what make the stack safe to keep across a directory
 * switch and across someone else editing the layout: an entry only applies if
 * the file is still exactly where that write left it.
 */
type UndoEntry = { path: string; previous: string | null; wrote: string };

const undoStack: UndoEntry[] = [];

function pushUndo(entry: UndoEntry): void {
  // A new analysis directory makes every older entry unreachable -- undo only
  // ever acts on the file it is looking at -- and keeping them around means the
  // first undo someone types in the new directory pops a stranger's entry and
  // reports a change they never made.
  for (let i = undoStack.length - 1; i >= 0; i--) {
    if (undoStack[i].path !== entry.path) undoStack.splice(i, 1);
  }
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
}

export function undoDepth(): number {
  return undoStack.length;
}

/**
 * Drop the whole stack. `pushUndo` already discards entries for another
 * directory, so nothing in the product needs this; it is here so a test can
 * start from a known state, and so a future session_start hook has somewhere
 * obvious to call.
 */
export function resetDashboardUndo(): void {
  undoStack.length = 0;
}

function tmpPathFor(filePath: string): string {
  return `${filePath}.tmp.${randomBytes(8).toString("hex")}`;
}

/**
 * Stage the new text beside the file, re-check that the file still has the
 * revision we based the change on, then rename over it.
 *
 * Like `writeNotebook`, the check sits between the staging write and the
 * rename, which narrows the window to a single syscall without closing it.
 * `wx` means the scratch file is created or the write fails, so a planted
 * symlink at a scratch name cannot redirect it either.
 */
async function swapInto(
  filePath: string,
  text: string,
  baseRevision: string | null,
): Promise<"ok" | "conflict"> {
  const tmp = tmpPathFor(filePath);
  await fsp.writeFile(tmp, text, { encoding: "utf-8", flag: "wx" });
  try {
    const current = dashboardRevision(await readRaw(filePath));
    if (current !== baseRevision) return "conflict";
    await fsp.rename(tmp, filePath);
    return "ok";
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Read -> apply -> write as a compare-and-swap against the shared revision.
 *
 * `apply` runs against each attempt's freshly validated document and returns
 * the document to persist, or a refusal that abandons the write with nothing
 * written. Validation of the result is the caller's job -- it has the better
 * error messages -- but the text is capped here because the shells cap it too.
 */
export async function updateDashboardDocument(
  apply: (
    current: DashboardDocument,
    exists: boolean,
  ) => { ok: true; document: DashboardDocument } | DashboardStoreFailure,
): Promise<DashboardWriteResult> {
  const filePath = getDashboardPath();
  if (!filePath) return { ok: false, error: NO_SESSION };

  // Serialized per path, for the same reason the shells are: two tool calls in
  // the same turn could otherwise both read, both apply and both write, and the
  // second would silently replace the first.
  return withLayoutLock(filePath, () => updateLocked(filePath, apply));
}

async function updateLocked(
  filePath: string,
  apply: (
    current: DashboardDocument,
    exists: boolean,
  ) => { ok: true; document: DashboardDocument } | DashboardStoreFailure,
): Promise<DashboardWriteResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const refusal = await refuseSymlink(filePath);
    if (refusal) return { ok: false, error: refusal };

    const current = await readDashboardDocument();
    if (!current.ok) return current;

    const applied = apply(current.document, current.exists);
    if (!applied.ok) return applied;

    const text = serializeDashboardDocument(applied.document);
    if (Buffer.byteLength(text, "utf-8") > DASHBOARD_MAX_BYTES) {
      return {
        ok: false,
        error: `That layout is larger than ${DASHBOARD_MAX_BYTES} bytes; nothing was written.`,
      };
    }

    let outcome: "ok" | "conflict";
    try {
      outcome = await swapInto(filePath, text, current.revision);
    } catch (err) {
      return { ok: false, error: fsFailure("write", err) };
    }
    if (outcome === "conflict") continue;

    // Snapshot what we just replaced, taken from the read that this write was
    // based on. Re-reading here would capture our own bytes.
    const revision = dashboardRevision(text) as string;
    pushUndo({ path: filePath, previous: current.raw, wrote: revision });
    return { ok: true, document: applied.document, path: filePath, revision };
  }

  return {
    ok: false,
    error: "The dashboard file kept changing while it was being updated; nothing was written.",
  };
}

/**
 * Replace the layout outright, without reading what is there first.
 *
 * The one path that must survive a file the reader refuses -- over the size
 * cap, or corrupt beyond repair -- because it is the documented way out of
 * exactly that state. There is no compare-and-swap here by design: the caller
 * is a user typing `/dashboard reset`, which means "whatever is there, I want
 * the default", and a conflict check would just refuse them again.
 *
 * Undo still works when the old file can be held in memory. When it cannot, the
 * change is recorded as un-undoable rather than as "there was no file", because
 * the latter would have undo delete a file it never created.
 */
export async function replaceDashboardDocument(
  document: DashboardDocument,
): Promise<DashboardWriteResult & { undoable?: boolean }> {
  const filePath = getDashboardPath();
  if (!filePath) return { ok: false, error: NO_SESSION };

  // Skipping the compare-and-swap is the point here; skipping the lock is not.
  // Unserialized, this interleaves with an in-flight update and one of the two
  // loses: measured against real directories, both calls reported success and
  // the reset's bytes were not the ones on disk in the large majority of
  // trials. Which one loses depends on where the renames fall relative to the
  // update's check; the lock is what stops there being a question.
  return withLayoutLock(filePath, () => replaceLocked(filePath, document));
}

async function replaceLocked(
  filePath: string,
  document: DashboardDocument,
): Promise<DashboardWriteResult & { undoable?: boolean }> {
  // The size cap is skipped -- that is the point -- but a symlink is still
  // refused, because "the user asked for it" does not extend to a file of
  // theirs somewhere else.
  const refusal = await refuseSymlink(filePath, false);
  if (refusal) return { ok: false, error: refusal };

  const text = serializeDashboardDocument(document);
  if (Buffer.byteLength(text, "utf-8") > DASHBOARD_MAX_BYTES) {
    return {
      ok: false,
      error: `That layout is larger than ${DASHBOARD_MAX_BYTES} bytes; nothing was written.`,
    };
  }

  let previous: string | null = null;
  let undoable = true;
  try {
    previous = await readRaw(filePath);
  } catch {
    undoable = false;
  }

  const tmp = tmpPathFor(filePath);
  try {
    await fsp.writeFile(tmp, text, { encoding: "utf-8", flag: "wx" });
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, error: fsFailure("write", err) };
  }

  const revision = dashboardRevision(text) as string;
  if (undoable) pushUndo({ path: filePath, previous, wrote: revision });
  return { ok: true, document, path: filePath, revision, undoable };
}

export type DashboardUndoResult =
  { ok: true; restored: "previous" | "none"; path: string } | DashboardStoreFailure;

/** Put back whatever the last write here replaced. */
export async function undoDashboardChange(): Promise<DashboardUndoResult> {
  const filePath = getDashboardPath();
  if (!filePath) return { ok: false, error: NO_SESSION };
  // Same lock as every other write here. The restore is a compare-and-swap, but
  // interleaved with an update both can pass their checks against the same
  // revision, and then the one that renames last decides what survives -- the
  // other having already reported success. The `rm` branch has no swap at all
  // underneath it.
  //
  // One consequence worth knowing: an undo typed during a tool call now queues
  // behind that call rather than racing it, so it undoes the tool's write.
  return withLayoutLock(filePath, () => undoLocked(filePath));
}

async function undoLocked(filePath: string): Promise<DashboardUndoResult> {
  if (undoStack.length === 0) {
    return {
      ok: false,
      error: "Nothing to undo -- no dashboard change has been made this session.",
    };
  }

  const refusal = await refuseSymlink(filePath);
  if (refusal) return { ok: false, error: refusal };

  // An entry for another directory can only be here if the notebook moved
  // mid-session; it can never apply again, and popping it one at a time would
  // report a stranger's change to whoever types undo next.
  while (undoStack.length > 0 && undoStack[undoStack.length - 1].path !== filePath) {
    undoStack.pop();
  }
  if (undoStack.length === 0) {
    return {
      ok: false,
      error: "Nothing to undo -- no dashboard change has been made in this analysis.",
    };
  }

  const entry = undoStack[undoStack.length - 1];
  // Only undo a change that is still the last thing to have happened here. If
  // the user rearranged the pane afterwards, restoring this would throw away
  // work nobody asked us to touch.
  let currentRevision: string | null;
  try {
    currentRevision = dashboardRevision(await readRaw(filePath));
  } catch (err) {
    return { ok: false, error: fsFailure("read", err) };
  }
  if (currentRevision !== entry.wrote) {
    undoStack.pop();
    return { ok: false, error: CHANGED_SINCE };
  }

  const previous = entry.previous;
  try {
    if (previous === null) {
      await fsp.rm(filePath, { force: true });
    } else {
      // Through the same compare-and-swap a normal write uses, so the revision
      // is re-checked after staging rather than before: checking only up front
      // leaves a window the width of a whole writeFile for someone else's save
      // to land and be clobbered by the undo.
      if ((await swapInto(filePath, previous, entry.wrote)) === "conflict") {
        undoStack.pop();
        return { ok: false, error: CHANGED_SINCE };
      }
    }
  } catch (err) {
    return { ok: false, error: fsFailure("restore", err) };
  }

  undoStack.pop();
  return { ok: true, restored: previous === null ? "none" : "previous", path: filePath };
}
