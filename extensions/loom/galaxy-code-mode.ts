/**
 * galaxy-mcp code-mode tool resolution.
 *
 * In code-mode the server exposes three meta-tools instead of ~40 named ones;
 * every Galaxy call is dispatched through `run_galaxy_tool({ name, args })`
 * (registered as `galaxy_run_galaxy_tool`). That means the tool_* events all
 * carry the meta-tool's name, not the underlying Galaxy tool -- which silently
 * breaks anything that keys off the real tool name (the connection/history
 * hooks, credential redaction). These helpers recover the underlying tool so
 * that logic works in both named mode and code-mode.
 */

export const GALAXY_CODE_MODE_TOOL = "galaxy_run_galaxy_tool";

/**
 * The effective `galaxy_`-prefixed tool name for a tool event. In code-mode,
 * reads the dispatched tool from the meta-tool args (`{ name, args }`) and
 * returns it prefixed (`create_history` -> `galaxy_create_history`); in named
 * mode the tool name passes through unchanged.
 */
export function resolveGalaxyToolName(
  toolName: string | undefined,
  args: unknown,
): string | undefined {
  if (toolName !== GALAXY_CODE_MODE_TOOL) return toolName;
  const inner =
    args && typeof args === "object" ? (args as Record<string, unknown>).name : undefined;
  return typeof inner === "string" ? `galaxy_${inner}` : toolName;
}
