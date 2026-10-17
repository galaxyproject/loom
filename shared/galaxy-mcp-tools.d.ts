export const GALAXY_MCP_PREFIX: "mcp__galaxy__";
export function galaxyMcpTool(tool: string): string;
export function galaxyMcpToolName(toolName: string | undefined): string | undefined;
export function isGalaxyMcpTool(toolName: string | undefined): boolean;

export interface GalaxyToolFamily {
  tool(tool: string): string;
  toolName(toolName: string | undefined): string | undefined;
}
export const MCP_FAMILY: Readonly<GalaxyToolFamily>;
export function bareFamily(tools: Iterable<string>): Readonly<GalaxyToolFamily>;
export function hasConnectTool(family: GalaxyToolFamily): boolean;
