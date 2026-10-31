/**
 * The record store's process-wide state: the store a shell installed and the per-key write lock.
 *
 * Kept apart from record-store.ts, which imports the fs-backed file store, so the in-process
 * Galaxy tool policy (galaxy-op-policy.ts) -- which runs in the browser worker too -- can wait its
 * turn behind the record's writers without pulling a Node module into its graph. record-store.ts
 * re-exports all of it, so every other caller still imports from there.
 */

import type { RecordStore } from "./record-store";

// The shell seam. Deliberately outside state.ts so resetState() (which every
// session_start runs before initSessionArtifacts) leaves it alone.
let installed: RecordStore | null = null;

// Every store installed in this process, by key. A write that outlives a conversation switch
// (a capture or a poll tick pinned to the record it started on) resolves its own store here
// rather than the one bound now.
const byKey = new Map<string, RecordStore>();

/** Install `store` as the bound record, keeping earlier ones by key; null forgets them all. */
export function setRecordStore(store: RecordStore | null): void {
  installed = store;
  if (store) byKey.set(store.key, store);
  else byKey.clear();
}

/** Keep `store` by key without binding it: an unshown conversation's record a shell polls. */
export function addRecordStore(store: RecordStore): void {
  byKey.set(store.key, store);
}

export function installedRecordStore(): RecordStore | null {
  return installed;
}

/** The store installed under `key`, bound or not. */
export function installedRecordStoreFor(key: string): RecordStore | null {
  return byKey.get(key) ?? null;
}

/**
 * Per-key mutex chain. Two parallel `upsertInvocationBlock` calls (e.g.
 * `galaxy_invocation_check_all` polling several invocations concurrently)
 * would race read-modify-write on the same record: each reads the
 * pre-update content, applies its block, and the second writer overwrites
 * the first. Serializing via a per-key Promise chain prevents the lost
 * update without paying for an OS-level lock.
 */
const writeLocks = new Map<string, Promise<void>>();

export function withRecordLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  // Always clear so completed locks don't pin memory; the chain is preserved
  // through the Promise we just created.
  writeLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
