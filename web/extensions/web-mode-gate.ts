/**
 * Web-mode gate -- Pi extension loaded by web/server.ts when LOOM_MODE=remote.
 *
 * Default-DENY allowlist for the remote brain's tool surface. The agent may
 * only reach the curated remote surface:
 *   - Galaxy / BRC-Analytics MCP tools (mcp__galaxy__*, mcp__brc_analytics__*)
 *     and the brain's own Galaxy tools (galaxy_*)
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
import { classifyGalaxyDestructive } from "../../shared/galaxy-destructive.js";
import { readEnv } from "../../shared/orbit-env.js";

// pi built-in file tools, confined to the notebook path allowlist.
const PATH_GATED_TOOLS = new Set(["edit", "write", "read"]);

// The curated remote surface. pi names MCP tools "mcp__<server>__<tool>", with
// anything outside [A-Za-z0-9_] in the server name turned into "_". galaxy_*,
// gtn_* and notebook_* are brain-registered tools.
const ALLOWED_PREFIXES = ["mcp__galaxy__", "mcp__brc_analytics__", "galaxy_", "gtn_", "notebook_"];

/**
 * Another server's tools can pass a plain startsWith: "galaxy_" or "galaxy-"
 * gives mcp__galaxy___<tool>, and "galaxy__x" gives mcp__galaxy__x__<tool>.
 * The curated servers' own tool names never start with "_" or contain "__".
 */
function hasToolPrefix(toolName: string, prefix: string): boolean {
  if (!toolName.startsWith(prefix)) return false;
  if (!prefix.startsWith("mcp__")) return true;
  const tool = toolName.slice(prefix.length);
  return !tool.startsWith("_") && !tool.includes("__");
}

// Allowed tool names that don't share one of the prefixes above.
// The MCP output reader only inspects registered artifacts from this session.
// `loom_propose` is the model's one registry write, validated before it lands.
const ALLOWED_EXACT = new Set(["skills_fetch", "mcp_read_output", "loom_propose"]);

// Brain tools that share an allowed prefix but must not run remotely. The
// local-file uploader resolves whatever absolute path it is handed and sends
// the bytes to Galaxy, so in the web shell or the interactive tool it would
// read the container's own files -- the Loom config with the operator's key
// included -- past the notebook-only jail above. Remote users have no local
// files to upload anyway; the URL upload covers that path.
const DENIED_EXACT = new Set(["galaxy_upload_local_file"]);

// ─────────────────────────────────────────────────────────────────────────────
// The trustedRecord profile (registry design v3 §11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The interactive tool's guaranteed profile: an exact allowlist, so the
 * registry and the notebook can only change through tools whose effect has
 * been reviewed. The prefix allowlist above lets any `galaxy_*` or
 * `mcp__galaxy__*` tool through, including the raw submission tools and code
 * mode; under this profile only the names below run, with the argument
 * constraints in `TRUSTED_RECORD_CONSTRAINTS`, and everything else -- a new
 * tool, a renamed one, another MCP server, a proxy -- is denied.
 *
 * Opt-in (`LOOM_TRUSTED_RECORD=1`), and off by default for now: with the raw
 * submission tools denied, nothing can run a tool or a workflow until
 * `loom_submit` (registry slice 3) exists. The schema-digest pinning v3 asks
 * for, and the exact galaxy-mcp pin in the GxIT image, come with enabling it.
 */
export const TRUSTED_RECORD_ALLOWED: ReadonlySet<string> = new Set([
  // Loom-native, reviewed with the registry.
  "loom_propose",
  "loom_submit",
  "galaxy_invocation_record",
  "galaxy_job_record",
  "galaxy_invocation_check_all",
  "galaxy_invocation_check_one",
  "notebook_push_to_galaxy",
  "notebook_pull_from_galaxy",
  "notebook_link_galaxy_page",
  "notebook_list_galaxy_pages",
  "notebook_resume_from_galaxy",
  "gtn_search",
  "gtn_fetch",
  "skills_fetch",
  "mcp_read_output",
  "lessons_search",
  // galaxy-mcp: reads, and writes that land in Galaxy rather than here.
  "mcp__galaxy__connect",
  "mcp__galaxy__get_server_info",
  "mcp__galaxy__get_user",
  "mcp__galaxy__search",
  "mcp__galaxy__search_tools_by_keywords",
  "mcp__galaxy__search_tools_by_name",
  "mcp__galaxy__get_tool_panel",
  "mcp__galaxy__get_tool_details",
  "mcp__galaxy__get_tool_input_template",
  "mcp__galaxy__get_tool_citations",
  "mcp__galaxy__get_tool_run_examples",
  "mcp__galaxy__recommend_biocontainer",
  "mcp__galaxy__get_schemas",
  "mcp__galaxy__list_workflows",
  "mcp__galaxy__get_workflow_details",
  "mcp__galaxy__get_workflow_input_template",
  "mcp__galaxy__get_histories",
  "mcp__galaxy__list_history_ids",
  "mcp__galaxy__get_history_details",
  "mcp__galaxy__get_history_contents",
  "mcp__galaxy__get_dataset_details",
  "mcp__galaxy__get_collection_details",
  "mcp__galaxy__get_job_details",
  "mcp__galaxy__get_invocations",
  "mcp__galaxy__create_history",
  "mcp__galaxy__update_history",
  "mcp__galaxy__search_iwc_workflows",
  "mcp__galaxy__get_iwc_workflows",
  "mcp__galaxy__get_iwc_workflow_details",
  "mcp__galaxy__recommend_iwc_workflows",
  "mcp__galaxy__import_workflow_from_iwc",
  "mcp__galaxy__upload_file_from_url",
  "mcp__galaxy__get_page",
  "mcp__galaxy__list_pages",
  "mcp__galaxy__list_page_revisions",
  "mcp__galaxy__get_page_revision",
  "mcp__galaxy__create_user_tool",
  "mcp__galaxy__list_user_tools",
  "mcp__galaxy__download_dataset",
]);

/** Tools deliberately left out, with why. Anything in neither list is denied too. */
export const TRUSTED_RECORD_EXCLUDED: Readonly<Record<string, string>> = {
  mcp__galaxy__run_tool: "submits outside the approval; loom_submit is the gated path",
  mcp__galaxy__invoke_workflow: "submits outside the approval; loom_submit is the gated path",
  mcp__galaxy__run_user_tool: "submits outside the approval; loom_submit is the gated path",
  mcp__galaxy__run_galaxy_tool: "code mode runs arbitrary operations",
  mcp__galaxy__delete_user_tool: "not reviewed yet",
  mcp__galaxy__cancel_workflow_invocation: "not reviewed yet",
  mcp__galaxy__upload_file: "reads a file on the Loom host",
  mcp__galaxy__create_page:
    "Page content carries the registry; notebook_push_to_galaxy is the one writer",
  mcp__galaxy__update_page:
    "Page content carries the registry; notebook_push_to_galaxy is the one writer",
  mcp__galaxy__revert_page_revision:
    "Page content carries the registry; notebook_push_to_galaxy is the one writer",
  galaxy_upload_local_file: "reads a file on the Loom host",
  lesson_propose: "writes the local lesson bank, which the registry profile doesn't review",
  dashboard_read: "dashboards are not part of the guaranteed surface",
  dashboard_update: "dashboards are not part of the guaranteed surface",
  team_dispatch: "experiment; spawns agents outside the profile",
  chat_search: "experiment; not reviewed",
  chat_find_tool_calls: "experiment; not reviewed",
  chat_session_context: "experiment; not reviewed",
  local_exec: "local execution",
};

/** Argument constraints on allowlisted tools; a refusal reason, or null. */
const TRUSTED_RECORD_CONSTRAINTS: Readonly<
  Record<string, (input: Record<string, unknown>) => string | null>
> = {
  // The memory form only: with a file_path galaxy-mcp writes wherever it is told.
  mcp__galaxy__download_dataset: (input) =>
    input.file_path !== undefined && input.file_path !== null
      ? "download_dataset with a file_path writes a local file; use it without one"
      : null,
  // Same rule as the default profile: no destructive history update.
  mcp__galaxy__update_history: (input) =>
    classifyGalaxyDestructive("mcp__galaxy__update_history", input)
      ? "a destructive history update"
      : null,
};

export function isTrustedRecordProfile(): boolean {
  return readEnv("TRUSTED_RECORD") === "1";
}

function trustedRecordBlock(
  toolName: string,
  input: Record<string, unknown>,
): BlockDecision | undefined {
  if (!TRUSTED_RECORD_ALLOWED.has(toolName)) {
    const why = TRUSTED_RECORD_EXCLUDED[toolName];
    return {
      block: true,
      reason: why
        ? `${toolName} is not available under the trusted-record profile: ${why}`
        : `${toolName} is not on the trusted-record allowlist`,
    };
  }
  const refusal = TRUSTED_RECORD_CONSTRAINTS[toolName]?.(input);
  if (refusal) return { block: true, reason: `${toolName}: ${refusal}` };
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
  profile: "default" | "trustedRecord" = "default",
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
  // Destructive Galaxy ops (whole-history delete/purge) -- called directly or via the
  // code-mode run_galaxy_tool envelope -- are blocked in remote mode: this gate has no
  // confirmation UI to require an are-you-sure (#338). It runs before the allowlist so a
  // delete/purge isn't waved through as a curated Galaxy call. A remote-confirm UX is a
  // follow-up.
  if (classifyGalaxyDestructive(toolName, input)) {
    return {
      block: true,
      reason: `${toolName} is a destructive Galaxy operation; blocked in remote mode (no confirmation UI available)`,
    };
  }
  if (profile === "trustedRecord") return trustedRecordBlock(toolName, input);
  // Denied by name before the prefix check, so an allowed prefix can't wave it through.
  if (DENIED_EXACT.has(toolName)) {
    return {
      block: true,
      reason: `${toolName} reads files on the Loom host; not available in remote mode (use the URL upload)`,
    };
  }
  // Curated remote surface -> allowed.
  if (ALLOWED_EXACT.has(toolName)) return undefined;
  if (ALLOWED_PREFIXES.some((p) => hasToolPrefix(toolName, p))) return undefined;
  // Default deny: bash/grep/find/ls, egress tools, experiments, future tools.
  return { block: true, reason: `${toolName} is not available in remote mode` };
}

function parseAllowlist(): string[] {
  const raw = readEnv("NOTEBOOK_ALLOWLIST");
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
  const profile = isTrustedRecordProfile() ? "trustedRecord" : "default";

  pi.on("tool_call", async (event) => {
    return shouldBlockTool(event.toolName, event.input, allowlist, cwd, profile);
  });
}
