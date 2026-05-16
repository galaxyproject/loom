/**
 * Web-mode gate -- Pi extension loaded by web/server.ts when LOOM_MODE=remote.
 *
 * Blocks `bash` outright. Confines `edit`/`write`/`read` to a path allowlist
 * (the brain's notebook.md, in practice). Other tools pass through.
 *
 * Path comparisons walk the deepest existing prefix through realpath so a
 * pre-existing symlink in `/tmp/loom-session/` can't redirect a gated tool
 * to a file outside the allowlist. The pure helpers are exported for unit
 * tests.
 */

import { resolve, dirname, basename, join } from "node:path";
import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PATH_GATED_TOOLS = new Set(["edit", "write", "read"]);
const BLOCKED_TOOLS = new Set(["bash", "grep", "find", "ls"]);

/**
 * Resolve an absolute path with symlink collapsing. Walks up until it finds
 * a component that exists, realpaths it, then rejoins the non-existent
 * suffix. This way notebook.md's first write (target doesn't exist yet) is
 * still compared against the same realpath'd parent as later reads.
 */
function realResolve(absPath: string): string {
  let current = resolve(absPath);
  const suffix: string[] = [];
  while (current !== dirname(current)) {
    try {
      const real = realpathSync(current);
      return suffix.length === 0 ? real : join(real, ...suffix.reverse());
    } catch {
      suffix.push(basename(current));
      current = dirname(current);
    }
  }
  return resolve(absPath);
}

export function isPathAllowed(
  rawPath: string,
  allowlist: string[],
  cwd: string = process.cwd(),
): boolean {
  const resolved = realResolve(resolve(cwd, rawPath));
  return allowlist.some((entry) => realResolve(resolve(entry)) === resolved);
}

export interface BlockDecision {
  block: true;
  reason: string;
}

export function shouldBlockTool(
  toolName: string,
  input: Record<string, unknown>,
  allowlist: string[],
  cwd: string,
): BlockDecision | undefined {
  if (BLOCKED_TOOLS.has(toolName)) {
    return { block: true, reason: `${toolName} is disabled in remote mode` };
  }
  if (!PATH_GATED_TOOLS.has(toolName)) return undefined;
  const path = input.path;
  if (typeof path !== "string") return undefined;
  if (isPathAllowed(path, allowlist, cwd)) return undefined;
  return { block: true, reason: `path "${path}" is not in the remote-mode allowlist` };
}

function parseAllowlist(): string[] {
  const raw = process.env.LOOM_NOTEBOOK_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI): void {
  const allowlist = parseAllowlist();
  const cwd = process.cwd();

  pi.on("tool_call", async (event) => {
    return shouldBlockTool(event.toolName, event.input, allowlist, cwd);
  });
}
