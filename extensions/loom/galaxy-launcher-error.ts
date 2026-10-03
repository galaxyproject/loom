// Galaxy MCP can fail two very different ways, and the recovery differs, so
// telling them apart matters more than the message wording.
//
// galaxy-transport-error.ts covers a *live* server whose stdio transport died:
// `/mcp reconnect galaxy` fixes that. This file covers the server never having
// started, because the `uvx` that launches it is not on PATH -- pi reports
// `spawn uvx ENOENT`. Reconnecting cannot fix that: there is nothing to
// reconnect to until uv is installed. Left unclassified, the model improvises
// and hands the user the reconnect incantation, which burns their time on an
// action that cannot possibly work.
//
// Orbit bundles uv and prepends it to the brain's PATH, so packaged desktop
// users should never see this. It reaches people running from source, standalone
// CLI installs, and packaged installs whose bundled uv is missing or not
// executable.

import { uvxMissingNotice } from "../../shared/uvx-runner.js";
import { isGalaxyMcpTool } from "../../shared/galaxy-mcp-tools.js";

// Deliberately narrow. A missing launcher is always a spawn/ENOENT failure
// naming the runner; anything vaguer risks swallowing a real Galaxy error and
// telling the user to install software they already have.
const LAUNCHER_ERROR_PATTERNS: RegExp[] = [
  /spawn\s+uvx\b/i, // Node's spawn error text: "spawn uvx ENOENT"
  /\buvx\b[^\n]*\bENOENT\b/i, // same failure, wrapped by another layer
  /\bENOENT\b[^\n]*\buvx\b/i, // ...in either order
];

/** One-line UI form. The full multi-line notice is uvxMissingNotice(). */
export const GALAXY_UVX_MISSING_NUDGE =
  "Galaxy tools are unavailable: the `uvx` runner that launches galaxy-mcp is not installed. " +
  "Install uv (https://docs.astral.sh/uv/), then restart Loom. " +
  "Reconnecting will not help until uv is present.";

/**
 * Does this galaxy_* tool result mean the MCP server could not be launched?
 * Pure so it can be unit-tested without a live session.
 */
export function isGalaxyLauncherError(
  toolName: string | undefined,
  text: string | undefined,
): boolean {
  if (!isGalaxyMcpTool(toolName)) return false;
  if (!text) return false;
  return LAUNCHER_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Full guidance for the failure, reusing the CLI's notice so the two surfaces
 * cannot drift apart.
 */
export function galaxyLauncherGuidance(): string {
  return uvxMissingNotice();
}
