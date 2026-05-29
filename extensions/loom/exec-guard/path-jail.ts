import * as fs from "fs";
import * as path from "path";
import type { PathResolver } from "./types";

function realpathDeepest(target: string): string {
  // realpath the longest existing prefix, then re-append the missing tail.
  let cur = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(target); // hit the root, nothing exists
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function createPathResolver(roots: string[]): PathResolver {
  const realRoots = roots
    .map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return path.resolve(r);
      }
    })
    .filter(Boolean);
  return {
    contains(targetPath: string) {
      const resolved = realpathDeepest(targetPath);
      const inside = realRoots.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep),
      );
      return { resolved, inside };
    },
  };
}
