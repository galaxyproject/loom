/**
 * The record store: one interface over the durable record.
 *
 * On the desktop the record is `notebook.md` in the session cwd and the backend
 * is the file store (record-store-file.ts). Under the browser shell the record
 * is a Galaxy page and the shell installs the page store (record-store-page.ts)
 * with `setRecordStore`. Every reader and writer of the record resolves its
 * store from the key `getNotebookPath()` hands out, so the callers do not know
 * which backend they are on.
 *
 * This file has no Node imports of its own: the file backend is the only record
 * module with fs/chokidar edges, and the browser's conformance test counts them.
 */

import { createFileRecordStore } from "./record-store-file";
import { installedRecordStore } from "./record-store-seam";

export { installedRecordStore, setRecordStore, withRecordLock } from "./record-store-seam";

/**
 * Opaque, never empty; equal strings mean the record did not change between two
 * looks. File: `dev:ino:size:mtimeMs:ctimeMs`. Page: the content hash.
 */
export type RecordVersion = string;

export interface RecordSnapshot {
  content: string;
  version: RecordVersion | null;
}

export interface RecordStore {
  readonly kind: "file" | "page";
  /**
   * `getNotebookPath()`'s string: the lock key and the anchor the side stores
   * (activity log, template replay) hang their `dirname` off. Path-shaped under
   * both backends.
   */
  readonly key: string;
  /** What a human or the model sees: the path, or `Galaxy page <id>`. */
  readonly label: string;
  /**
   * The Galaxy page that is the record, under the page backend. The brain's update_page
   * policy and the evidence gate compare it with a tool call's page_id to tell a write to
   * the record from a write to some other page.
   */
  readonly pageId?: string;
  /** null when absent or unstattable; never throws. `(await stat()) !== null` is the existence check. */
  stat(): Promise<RecordVersion | null>;
  /** Version taken before the body. Throws the backend's own error when missing (ENOENT / GalaxyApiError 404). */
  read(): Promise<RecordSnapshot>;
  /**
   * Unconditional unless `expect` is given, then a compare-and-swap: throws
   * NotebookChangedError and leaves the record untouched when the version moved.
   */
  write(content: string, expect?: RecordVersion): Promise<void>;
  /** Create an empty record if absent; true when it created one. */
  ensure(): Promise<boolean>;
  /**
   * Backend change feed (file: chokidar, own writes included; page: own writes
   * only). Returns unsubscribe; the last unsubscribe releases the watcher.
   */
  onChange(cb: (content: string) => void): () => void;
}

/** Thrown by a guarded `write` when the record moved under the caller. */
export class NotebookChangedError extends Error {
  constructor(key: string) {
    super(`Notebook changed on disk since it was read: ${key}`);
    this.name = "NotebookChangedError";
  }
}

/**
 * The store for a record key: the installed one when the key is its key, else
 * a file store for that path. Resolving by key rather than by "is a store
 * installed" keeps every test that points getNotebookPath at a real tmp file
 * on the file backend.
 */
export function recordStore(key: string): RecordStore {
  const installed = installedRecordStore();
  if (installed && installed.key === key) return installed;
  return createFileRecordStore(key);
}

/**
 * How many times a guarded update re-reads and retries before giving up. A
 * write only loses the version check when someone else wrote in the
 * microseconds between our read and our write; three attempts is far more than
 * convergence needs, and bounding it keeps a pathological writer from spinning
 * us.
 */
export const MAX_CAS_ATTEMPTS = 3;

/**
 * Read -> apply -> write as a compare-and-swap, retrying against fresh content
 * when the record moved under us.
 *
 * This is the discipline the poller already writes under (#391), packaged for
 * the callers that mutate a block from outside a poll. An unguarded whole-record
 * write renders the record from content captured before whatever landed in
 * between -- a poll advancing a block, an agent `edit`, a `bash` append -- and
 * the in-process lock cannot help, because it only orders Loom's own writers.
 *
 * Call with the record lock held. `read()` takes the version *before* the body
 * on purpose: a version taken afterwards would let a write that landed in
 * between look unchanged, which is the exact clobber this prevents, while
 * taking it first can only ever cost a spurious retry.
 *
 * `apply` runs against each attempt's fresh content and may throw to abandon
 * the update outright -- a validation that depends on what the record says now
 * belongs inside it, not before the loop.
 */
export async function withRecordCas<T>(
  store: RecordStore,
  apply: (content: string) => { content: string; result: T },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    // A record that's actually gone or unreadable fails here with its own
    // ENOENT/EACCES/404 instead of being dressed up as a race.
    const { content: fresh, version } = await store.read();
    // Readable but unversioned: without a version there's no compare-and-swap,
    // and an unguarded whole-record write is the thing this exists to stop.
    if (!version) {
      lastError = new NotebookChangedError(store.key);
      continue;
    }
    const { content, result } = apply(fresh);
    try {
      await store.write(content, version);
      return result;
    } catch (error) {
      if (!(error instanceof NotebookChangedError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
