/**
 * Where the in-process Galaxy tools come from. The brain registers pi tool definitions
 * carrying galaxy-ops' bare operation names (`run_tool`, `get_dataset_details`, ...) and hands
 * those names to every guard as the tool family.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bareFamily, type GalaxyToolFamily } from "../../shared/galaxy-tool-family.js";
import { galaxyReadOnly } from "./galaxy-grant";
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
 * Whether a read-only launch may register the tool: only one that declares itself read-only, so
 * an extra or bridge that says nothing is withheld rather than trusted.
 */
export const readsOnly = (tool: GalaxyTool): boolean => tool.annotations?.readOnlyHint === true;

/**
 * Register the installed source's tools, or the default source's, then its
 * companions, and return the family over the tools' names. Under a read-only
 * launch only the tools that declare readOnlyHint are registered, and the family
 * is theirs. Called once, from index.ts.
 */
export function registerGalaxyTools(pi: ExtensionAPI): GalaxyToolFamily {
  const source = installed ?? createGalaxyOpsToolSource();
  const keep = galaxyReadOnly() ? readsOnly : () => true;
  const tools = source.tools().filter(keep);
  const companions = (source.companions?.() ?? []).filter(keep);
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
 * How the brain names Galaxy tools to the model right now: the registered
 * source's names. For render-time readers (context.ts, the greeting);
 * registrars take the family as a parameter.
 */
export function galaxyToolFamily(): GalaxyToolFamily {
  return registered ?? bareFamily([]);
}
