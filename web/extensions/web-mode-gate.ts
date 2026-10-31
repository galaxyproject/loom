/**
 * Web-mode gate -- Pi extension loaded by web/server.ts when LOOM_MODE=remote.
 *
 * Default-DENY allowlist for the remote brain's tool surface. The agent may
 * only reach the curated remote surface:
 *   - the brain's in-process Galaxy tools, by their exact bare names, and its
 *     own galaxy_* tools; BRC-Analytics' MCP tools (mcp__brc_analytics__*)
 *   - the brain's HTTP helper tools (gtn_*, notebook_*, skills_fetch, ena_runs)
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
const ALLOWED_PREFIXES = ["mcp__brc_analytics__", "galaxy_", "gtn_", "notebook_"];

/**
 * The brain's in-process Galaxy tools: galaxy-ops' operations under their wire
 * names, plus the bridges Orbit adds. Bare names carry no prefix, so they are
 * listed exactly; a tool galaxy-ops adds later stays closed until it is listed
 * here (the test walks the registered tools to catch one). upload_file is
 * registered but hidden, and is denied below.
 */
export const GALAXY_TOOLS: ReadonlySet<string> = new Set([
  "get_user",
  "run_tool",
  "get_invocations",
  "get_server_info",
  "get_histories",
  "list_history_ids",
  "get_history_details",
  "create_history",
  "get_dataset_details",
  "get_collection_details",
  "get_history_contents",
  "list_workflows",
  "get_workflow_details",
  "get_tool_details",
  "search_tools_by_name",
  "get_tool_panel",
  "get_tool_citations",
  "get_tool_run_examples",
  "search_tools_by_keywords",
  "get_job_details",
  "update_history",
  "cancel_workflow_invocation",
  "get_iwc_workflows",
  "get_iwc_workflow_details",
  "search_iwc_workflows",
  "recommend_iwc_workflows",
  "import_workflow_from_iwc",
  "list_user_tools",
  "create_user_tool",
  "delete_user_tool",
  "run_user_tool",
  "get_tool_input_template",
  "get_workflow_input_template",
  "invoke_workflow",
  "upload_file_from_url",
  "list_pages",
  "get_page",
  "create_page",
  "update_page",
  "list_page_revisions",
  "get_page_revision",
  "revert_page_revision",
  "download_dataset",
  "recommend_biocontainer",
  "list_jobs",
  "get_job_logs",
]);

/**
 * Another server's tools can pass a plain startsWith: "brc_analytics_" gives
 * mcp__brc_analytics___<tool>, and "brc_analytics__x" gives
 * mcp__brc_analytics__x__<tool>. The curated server's own tool names never
 * start with "_" or contain "__".
 */
function hasToolPrefix(toolName: string, prefix: string): boolean {
  if (!toolName.startsWith(prefix)) return false;
  if (!prefix.startsWith("mcp__")) return true;
  const tool = toolName.slice(prefix.length);
  return !tool.startsWith("_") && !tool.includes("__");
}

// Allowed tool names that don't share one of the prefixes above.
// The MCP output reader only inspects brc-analytics' spilled output from this session.
// `loom_propose` is the model's one registry write, validated before it lands.
const ALLOWED_EXACT = new Set(["skills_fetch", "ena_runs", "mcp_read_output", "loom_propose"]);

// Brain tools that share an allowed name but must not run remotely. The
// local-file uploaders resolve whatever absolute path they are handed and send
// the bytes to Galaxy, so in the web shell or the interactive tool they would
// read the container's own files -- the Orbit config with the operator's key
// included -- past the notebook-only jail above. Remote users have no local
// files to upload anyway; the URL upload covers that path. galaxy-ops'
// upload_file is hidden from the model, which does not stop a call by name.
const DENIED_EXACT = new Set(["galaxy_upload_local_file", "upload_file"]);

// ─────────────────────────────────────────────────────────────────────────────
// The trustedRecord profile (registry design v3 §11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The interactive tool's guaranteed profile: an exact allowlist, so the
 * registry and the notebook can only change through tools whose effect has
 * been reviewed. The default allowlist above lets any `galaxy_*` tool and every
 * in-process Galaxy tool through, including the raw submission tools; under
 * this profile only the names below run, with the argument
 * constraints in `TRUSTED_RECORD_CONSTRAINTS`, and everything else -- a new
 * tool, a renamed one, another MCP server, a proxy -- is denied.
 *
 * Opt-in (`LOOM_TRUSTED_RECORD=1`), and off by default for now: with the raw
 * submission tools denied, nothing can run a tool or a workflow until
 * `loom_submit` (registry slice 3) exists. The schema-digest pinning v3 asks
 * for comes with enabling it.
 */
export const TRUSTED_RECORD_ALLOWED: ReadonlySet<string> = new Set([
  // Orbit-native, reviewed with the registry.
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
  "ena_runs",
  "skills_fetch",
  "mcp_read_output",
  "lessons_search",
  // In-process Galaxy tools: reads, and writes that land in Galaxy rather than here.
  "galaxy_read_output",
  "get_server_info",
  "get_user",
  "search_tools_by_keywords",
  "search_tools_by_name",
  "get_tool_panel",
  "get_tool_details",
  "get_tool_input_template",
  "get_tool_citations",
  "get_tool_run_examples",
  "recommend_biocontainer",
  "list_workflows",
  "get_workflow_details",
  "get_workflow_input_template",
  "get_histories",
  "list_history_ids",
  "get_history_details",
  "get_history_contents",
  "get_dataset_details",
  "get_collection_details",
  "get_job_details",
  "list_jobs",
  "get_job_logs",
  "get_invocations",
  "create_history",
  "update_history",
  "search_iwc_workflows",
  "get_iwc_workflows",
  "get_iwc_workflow_details",
  "recommend_iwc_workflows",
  "import_workflow_from_iwc",
  "upload_file_from_url",
  "get_page",
  "list_pages",
  "list_page_revisions",
  "get_page_revision",
  "create_user_tool",
  "list_user_tools",
  "download_dataset",
]);

/** Tools deliberately left out, with why. Anything in neither list is denied too. */
export const TRUSTED_RECORD_EXCLUDED: Readonly<Record<string, string>> = {
  run_tool: "submits outside the approval; loom_submit is the gated path",
  invoke_workflow: "submits outside the approval; loom_submit is the gated path",
  run_user_tool: "submits outside the approval; loom_submit is the gated path",
  delete_user_tool: "not reviewed yet",
  cancel_workflow_invocation: "not reviewed yet",
  upload_file: "reads a file on the Orbit host",
  create_page: "Page content carries the registry; notebook_push_to_galaxy is the one writer",
  update_page: "Page content carries the registry; notebook_push_to_galaxy is the one writer",
  revert_page_revision:
    "Page content carries the registry; notebook_push_to_galaxy is the one writer",
  galaxy_upload_local_file: "reads a file on the Orbit host",
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
  // The memory form only: with a file_path galaxy-ops writes wherever it is told.
  download_dataset: (input) =>
    input.file_path !== undefined && input.file_path !== null
      ? "download_dataset with a file_path writes a local file; use it without one"
      : null,
  // Same rule as the default profile: no destructive history update.
  update_history: (input) =>
    classifyGalaxyDestructive("update_history", input) ? "a destructive history update" : null,
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
  // Destructive Galaxy ops (whole-history delete/purge) -- called directly or through a
  // proxy -- stay blocked in remote mode (#338), even though the brain's destructive gate can
  // now confirm the tools galaxy-ops marks destructive here: a headless --mode json container
  // has no one to answer that confirm, and losing a whole history is the case not worth
  // risking. It runs before the allowlist so a delete/purge isn't waved through as a curated
  // Galaxy call.
  if (classifyGalaxyDestructive(toolName, input)) {
    return {
      block: true,
      reason: `${toolName} is a destructive Galaxy operation; blocked in remote mode (delete or purge the history in Galaxy itself)`,
    };
  }
  if (profile === "trustedRecord") return trustedRecordBlock(toolName, input);
  // Denied by name before the prefix check, so an allowed prefix can't wave it through.
  if (DENIED_EXACT.has(toolName)) {
    return {
      block: true,
      reason: `${toolName} reads files on the Orbit host; not available in remote mode (use the URL upload)`,
    };
  }
  // Curated remote surface -> allowed.
  if (ALLOWED_EXACT.has(toolName) || GALAXY_TOOLS.has(toolName)) return undefined;
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
