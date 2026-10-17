/**
 * Where the bare Galaxy tools come from when they run in-process rather than through an MCP
 * server.
 *
 * Under an `mcp` profile pi's MCP layer names galaxy-mcp's tools
 * (`mcp__galaxy__run_tool`) and nothing here registers anything. Under `bare`
 * the brain registers pi tool definitions carrying the bare names (`run_tool`,
 * `get_dataset_details`, ...) and hands those names to every guard as the tool family.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { capabilityProfile } from "../../shared/capability-profile.js";
import { MCP_FAMILY, bareFamily, type GalaxyToolFamily } from "../../shared/galaxy-mcp-tools.js";
import { createGalaxyOpsToolSource } from "./galaxy-ops-tools";

/** pi's own tool shape; the shim registers exactly this. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GalaxyTool = ToolDefinition<any, any, any>;

/**
 * The Galaxy tools registered in-process under their bare names.
 *
 * Orbit builds the list from galaxy-ops itself (`createGalaxyOpsToolSource`, the
 * default). A shell installs a source only to add tools its galaxy-ops entry
 * lacks, through that function's `extras`.
 */
export interface GalaxyToolSource {
  /** Registered once at extension load, in this order; their names are the bare family. */
  tools(): readonly GalaxyTool[];
  /** Registered after `tools()` but kept out of the family: readers no guard keys on. */
  companions?(): readonly GalaxyTool[];
}

let installed: GalaxyToolSource | null = null;
let registered: GalaxyToolFamily | null = null;
let registeredTools: readonly GalaxyTool[] = [];

/** null uninstalls and forgets the registered family. */
export function setGalaxyToolSource(source: GalaxyToolSource | null): void {
  installed = source;
  registered = null;
  registeredTools = [];
}

export function installedGalaxyToolSource(): GalaxyToolSource | null {
  return installed;
}

/**
 * Register the installed source's tools, or the default source's, then its
 * companions, and return the family over the tools' names. Called once, from
 * index.ts, under a `bare` profile.
 */
export function registerGalaxyTools(pi: ExtensionAPI): GalaxyToolFamily {
  const source = installed ?? createGalaxyOpsToolSource();
  const tools = source.tools();
  const companions = source.companions?.() ?? [];
  // pi keeps the last definition under a name, so a second one would silently
  // replace the first (an extra the entry already has, say) and pass as one tool.
  const names = new Set<string>();
  for (const { name } of [...tools, ...companions]) {
    if (names.has(name)) throw new Error(`[galaxy-tools] two Galaxy tools are named ${name}`);
    names.add(name);
  }
  for (const tool of tools) pi.registerTool(tool);
  for (const tool of companions) pi.registerTool(tool);
  registeredTools = [...tools, ...companions];
  registered = bareFamily(tools.map((t) => t.name));
  return registered;
}

/** The definitions registerGalaxyTools registered, for readers of their annotations. */
export function registeredGalaxyTools(): readonly GalaxyTool[] {
  return registeredTools;
}

/**
 * How the brain names Galaxy tools to the model right now: MCP under an mcp
 * profile, else the registered source's names. For render-time readers
 * (context.ts, the greeting); registrars take the family as a parameter.
 */
export function galaxyToolFamily(): GalaxyToolFamily {
  if (capabilityProfile().galaxyTools === "mcp") return MCP_FAMILY;
  return registered ?? bareFamily([]);
}
