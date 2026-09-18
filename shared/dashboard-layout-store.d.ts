/**
 * The layout file, read and written the same way by every process that touches
 * it. Node-only -- the renderer must not import this; it talks to the shells.
 */

export type LayoutReadResult =
  { ok: true; raw: string | null; revision: string | null } | { ok: false; error: string };

export type LayoutWriteResult =
  | { ok: true; revision: string }
  | {
      ok: false;
      error: string;
      conflict?: boolean;
      raw?: string | null;
      revision?: string | null;
    };

/** Run `fn` with nothing else on this path running at the same time. */
export function withLayoutLock<T>(absPath: string, fn: () => Promise<T>): Promise<T>;

/** For tests: is anything queued on any path? */
export function layoutLockIdle(): boolean;

/**
 * Read the layout file. A missing file is `{ok: true, raw: null}`; a symlink,
 * a non-file and anything over `maxBytes` are refusals.
 */
export function readLayoutFile(absPath: string, maxBytes: number): Promise<LayoutReadResult>;

/**
 * Replace the layout file if it still carries `baseRevision`. Pass `undefined`
 * for an unconditional write; `null` means "there should be no file yet".
 */
export function casWriteLayoutFile(
  absPath: string,
  raw: string,
  baseRevision: string | null | undefined,
  maxBytes: number,
): Promise<LayoutWriteResult>;
