/**
 * Web-mode gate -- Pi extension loaded by web/server.ts when LOOM_MODE=remote.
 *
 * Default-DENY allowlist for the remote brain's tool surface. The agent may
 * only reach the curated remote surface:
 *   - Galaxy / BRC-Analytics MCP tools (galaxy_*, brc_analytics_*)
 *   - the `mcp` proxy gateway, scoped to those same curated servers -- the only
 *     path to them on a cold-cache container, where direct tools don't register
 *   - the brain's HTTP helper tools (gtn_*, notebook_*, skills_fetch)
 *   - path-gated edit/write/read, confined to the session notebook.md
 * Everything else -- bash/grep/find/ls, the pi-web-access egress tools
 * (fetch_content/web_search/code_search/get_search_content), experiment-gated
 * team/chat tools, and anything added to the brain in the future -- is blocked.
 * Enumerating the keep-set rather than the block-set means a newly added tool
 * is closed by default instead of silently reachable.
 *
 * In remote mode this gate is the SOLE tool_call authority: web/server.ts sets
 * LOOM_LOCAL_EXEC=off so the brain skips its local-execution guard (there is no
 * local execution surface to guard in a container). The gate therefore can't
 * lean on that guard for the malformed-input case -- it normalizes
 * `path ?? file_path` the same way pi's file tools do before the jail check.
 *
 * Path comparisons walk the deepest existing prefix through realpath so a
 * pre-existing symlink in `/tmp/loom-session/` can't redirect a gated tool
 * to a file outside the allowlist. The pure helpers are exported for unit
 * tests.
 */

import { resolve, dirname, basename, join } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi built-in file tools, confined to the notebook path allowlist.
const PATH_GATED_TOOLS = new Set(["edit", "write", "read"]);

// The curated remote surface. MCP tools are "<server>_<tool>" with the server
// name's hyphens normalized to underscores (pi-mcp-adapter formatToolName,
// default "server" prefix): galaxy -> galaxy_, brc-analytics -> brc_analytics_.
// gtn_*/notebook_* are brain-registered HTTP helper tools.
const ALLOWED_PREFIXES = ["galaxy_", "brc_analytics_", "gtn_", "notebook_"];

// Allowed tool names that don't share one of the prefixes above.
const ALLOWED_EXACT = new Set(["skills_fetch"]);

// The curated MCP servers reachable through the `mcp` proxy gateway. On a
// cold-cache container -- every fresh remote launch -- pi-mcp-adapter never
// registers the galaxy_*/brc_analytics_* DIRECT tools (it needs a warm
// per-server metadata cache, and the per-user scoped GALAXY_API_KEY changes
// the cache's config hash every launch), so the single `mcp` proxy tool is the
// only path to those servers. We allow the proxy but scope it to these servers,
// matching the direct-tool surface ALLOWED_PREFIXES already permits.
const CURATED_MCP_SERVERS = new Set(["galaxy", "brc-analytics"]);

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Gate the pi-mcp-adapter `mcp` proxy gateway. Mirrors the proxy's own dispatch
 * precedence: a `tool` field is a server-side tool CALL and wins over
 * everything; `connect` opens a server connection. Both must target a curated
 * server -- a call with no server is unverifiable, so it's denied. The
 * remaining ops (search/describe/list/status/ui-messages) are read-only
 * discovery against already-configured servers and pass through.
 */
export function gateMcpProxy(input: Record<string, unknown>): BlockDecision | undefined {
  const tool = asTrimmedString(input.tool);
  if (tool) {
    const server = asTrimmedString(input.server);
    if (server && CURATED_MCP_SERVERS.has(server)) return undefined;
    return {
      block: true,
      reason: server
        ? `mcp proxy call to server "${server}" is blocked in remote mode (allowed: galaxy, brc-analytics)`
        : `mcp proxy tool calls must set "server" to one of: galaxy, brc-analytics`,
    };
  }
  const connect = asTrimmedString(input.connect);
  if (connect && !CURATED_MCP_SERVERS.has(connect)) {
    return {
      block: true,
      reason: `mcp proxy connect to "${connect}" is blocked in remote mode (allowed: galaxy, brc-analytics)`,
    };
  }
  return undefined;
}

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
  // pi's file tools render with `file_path ?? path`; check both so the jail
  // can't be slipped by emitting file_path instead of path. With the brain's
  // local-exec guard disabled in remote, this gate is the only enforcement.
  if (PATH_GATED_TOOLS.has(toolName)) {
    const raw = input.path ?? input.file_path;
    if (typeof raw !== "string") {
      return { block: true, reason: `${toolName} requires a path in remote mode` };
    }
    if (isPathAllowed(raw, allowlist, cwd)) return undefined;
    return { block: true, reason: `path "${raw}" is not in the remote-mode allowlist` };
  }
  // The MCP proxy gateway reaches the curated servers when their direct tools
  // aren't registered (cold cache). Allow it, scoped to those servers.
  if (toolName === "mcp") return gateMcpProxy(input);
  // Curated remote surface -> allowed.
  if (ALLOWED_EXACT.has(toolName)) return undefined;
  if (ALLOWED_PREFIXES.some((p) => toolName.startsWith(p))) return undefined;
  // Default deny: bash/grep/find/ls, egress tools, experiments, future tools.
  return { block: true, reason: `${toolName} is not available in remote mode` };
}

function parseAllowlist(): string[] {
  const raw = process.env.LOOM_NOTEBOOK_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Defense-in-depth: an allowlist entry that is itself a symlink would realResolve
 * to its target, so a write to notebook.md could land on a file outside the
 * session dir. The brain creates notebook.md as a regular file and the agent has
 * no symlink-creating tool, so this only guards a malicious pre-placed symlink
 * (e.g. a tampered image): drop any entry that already exists as a symlink. A
 * not-yet-existing entry is kept (notebook.md is created lazily as a real file).
 */
export function dropSymlinkedEntries(entries: string[]): string[] {
  return entries.filter((entry) => {
    try {
      if (lstatSync(entry).isSymbolicLink()) {
        console.error(`[web-mode-gate] dropping symlinked notebook allowlist entry: ${entry}`);
        return false;
      }
    } catch {
      /* doesn't exist yet -- keep; it will be created as a regular file */
    }
    return true;
  });
}

export default function (pi: ExtensionAPI): void {
  const allowlist = dropSymlinkedEntries(parseAllowlist());
  const cwd = process.cwd();

  pi.on("tool_call", async (event) => {
    return shouldBlockTool(event.toolName, event.input, allowlist, cwd);
  });
}
