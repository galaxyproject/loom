/**
 * Decide whether the currently-open file should be re-read from disk given the
 * set of paths the watcher reported as changed (#313).
 *
 * The files watcher coalesces a burst of fs events into one `files:changed`
 * notification carrying the set of changed cwd-relative paths. Refreshing the
 * open file on *every* event made the "changed on disk" banner fire whenever any
 * unrelated file changed: a dirty editor always differs from disk, so the diff
 * check (editor != disk) tripped even though the open file never changed. Gating
 * the refresh on a path match fixes that.
 */

function normalize(p: string): string {
  // The watcher emits posix paths, but normalize backslashes too so a Windows
  // relative path still matches the forward-slash open path.
  let s = p.replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  return s;
}

/**
 * @param openPath     cwd-relative path of the open file, or null if none open.
 * @param changedPaths set of changed cwd-relative paths, or null when the watcher
 *                     couldn't name what changed (refresh conservatively then).
 */
export function shouldRefreshOpenFile(
  openPath: string | null,
  changedPaths: readonly string[] | null,
): boolean {
  if (!openPath) return false;
  // Unknown batch -- we can't prove the open file is unaffected, so refresh
  // rather than risk leaving it stale. Worst case is a redundant re-read.
  if (changedPaths === null) return true;
  const open = normalize(openPath);
  return changedPaths.some((p) => normalize(p) === open);
}
