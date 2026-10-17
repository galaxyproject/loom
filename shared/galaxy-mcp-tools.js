/**
 * How Galaxy MCP tools are named on the pi side.
 *
 * pi's built-in MCP registers each server tool as `mcp__<server>__<tool>`, so
 * galaxy-mcp's `run_tool` reaches the model as `mcp__galaxy__run_tool`. Loom's
 * own Galaxy tools (galaxy_job_record, galaxy_upload_local_file, ...) are a
 * different family and keep their names.
 */
export const GALAXY_MCP_PREFIX = "mcp__galaxy__";

/** The pi tool name for a galaxy-mcp tool. @param {string} tool @returns {string} */
export function galaxyMcpTool(tool) {
  return GALAXY_MCP_PREFIX + tool;
}

/**
 * The galaxy-mcp tool behind a pi tool name, or undefined when it isn't one.
 * @param {string | undefined} toolName @returns {string | undefined}
 */
export function galaxyMcpToolName(toolName) {
  if (!toolName?.startsWith(GALAXY_MCP_PREFIX)) return undefined;
  const tool = toolName.slice(GALAXY_MCP_PREFIX.length);
  // Another server can share the prefix: "galaxy_" or "galaxy-" gives
  // mcp__galaxy___<tool>, "galaxy__x" gives mcp__galaxy__x__<tool>. galaxy-mcp's
  // own names never start with "_" or contain "__".
  return tool && !tool.startsWith("_") && !tool.includes("__") ? tool : undefined;
}

/** @param {string | undefined} toolName @returns {boolean} */
export function isGalaxyMcpTool(toolName) {
  return galaxyMcpToolName(toolName) !== undefined;
}

/**
 * How a shell names galaxy-mcp's tools to the model, so a guard can ask "is
 * this run_tool?" without knowing whether it runs under pi's MCP or in the
 * browser, which offers the same tools by their bare names.
 *
 * @typedef {object} GalaxyToolFamily
 * @property {(tool: string) => string} tool the model-facing name for a galaxy-mcp tool
 * @property {(toolName: string | undefined) => string | undefined} toolName
 *   the galaxy-mcp tool behind a model-facing name, or undefined when it isn't one
 */

/** @type {Readonly<GalaxyToolFamily>} */
export const MCP_FAMILY = Object.freeze({
  tool: (tool) => galaxyMcpTool(tool),
  toolName: (toolName) => galaxyMcpToolName(toolName),
});

/**
 * Bare names carry no marker, so a bare family has to be told which names are
 * galaxy-mcp's; anything else (bash, read, a shell's own tools) isn't Galaxy.
 *
 * @param {Iterable<string>} tools the galaxy-mcp tool names the shell offers bare
 * @returns {Readonly<GalaxyToolFamily>}
 */
export function bareFamily(tools) {
  const known = new Set(tools);
  return Object.freeze({
    tool: (tool) => tool,
    toolName: (toolName) => (toolName !== undefined && known.has(toolName) ? toolName : undefined),
  });
}

/**
 * Only the MCP server has a connect tool. A family without one has no session to re-bind, so a
 * caller treats credentials as the connection and drops the re-bind steps from its wording.
 *
 * @param {GalaxyToolFamily} family
 * @returns {boolean}
 */
export function hasConnectTool(family) {
  return family.toolName(family.tool("connect")) !== undefined;
}
