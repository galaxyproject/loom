import * as path from "path";

/**
 * An exact directory name selects that one scenario; anything else selects
 * every scenario whose directory starts with it, so a family that shares a
 * prefix (`galaxy-mcp-*`) runs as a group without a separate tagging scheme.
 */
export function filterScenarioDirs(dirs: string[], filter: string | undefined): string[] {
  if (!filter) return dirs;
  const exact = dirs.filter((dir) => path.basename(dir) === filter);
  if (exact.length > 0) return exact;
  return dirs.filter((dir) => path.basename(dir).startsWith(filter));
}
