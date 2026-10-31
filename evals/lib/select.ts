import * as path from "path";

/**
 * An exact directory name selects that one scenario; anything else selects
 * every scenario whose directory starts with it, so a family that shares a
 * prefix (`galaxy-tools-*`) runs as a group without a separate tagging scheme.
 */
export function filterScenarioDirs(dirs: string[], filter: string | undefined): string[] {
  if (!filter) return dirs;
  // A comma list lets one invocation run several families, e.g. "galaxy-tools,execution-after".
  const picked = new Set(
    filter
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean)
      .flatMap((term) => matchOne(dirs, term)),
  );
  return dirs.filter((dir) => picked.has(dir));
}

function matchOne(dirs: string[], term: string): string[] {
  const exact = dirs.filter((dir) => path.basename(dir) === term);
  if (exact.length > 0) return exact;
  return dirs.filter((dir) => path.basename(dir).startsWith(term));
}
