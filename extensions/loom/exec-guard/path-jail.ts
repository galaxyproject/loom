import * as fs from "fs";
import * as path from "path";
import type { PathResolver } from "./types";

// Expand a leading `~` or `$HOME`/`${HOME}` to the home dir. The shell does this
// in bash, and pi resolves `~` in its file tools, but `path.resolve` does not --
// so without this a `~/.aws/config` read resolves to `<cwd>/~/.aws/config` and
// dodges both the sensitive-read floor and the workspace jail.
function expandHome(p: string, home: string): string {
  if (!home) return p;
  if (p === "~" || p === "~/") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  const m = p.match(/^\$\{?HOME\}?(?=\/|$)/);
  if (m) return path.join(home, p.slice(m[0].length));
  return p;
}

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

export function createPathResolver(roots: string[], home = ""): PathResolver {
  const realRoots = roots
    .map((r) => {
      const expanded = expandHome(r, home);
      try {
        return fs.realpathSync(expanded);
      } catch {
        return path.resolve(expanded);
      }
    })
    .filter(Boolean);
  return {
    contains(targetPath: string) {
      const resolved = realpathDeepest(expandHome(targetPath, home));
      const inside = realRoots.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep),
      );
      return { resolved, inside };
    },
  };
}
