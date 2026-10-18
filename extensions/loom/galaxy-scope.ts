/** Give existing Galaxy guards/capture one canonical tool name and explicit origin. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { galaxyMcpServerName, galaxyMcpToolName } from "../../shared/galaxy-mcp-tools.js";
import {
  listGalaxyConnections,
  resolveGalaxyConnection,
  verifyGalaxyAccount,
  withGalaxyConnection,
} from "./galaxy-connections.js";

// The SDK's overloaded on()/registerTool() signatures cannot express a generic
// decorator. The cast is confined here; each registered handler keeps its API.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function scopeGalaxyExtension(pi: ExtensionAPI): ExtensionAPI {
  const scoped = Object.create(pi) as ExtensionAPI;
  scoped.on = ((event: string, handler: (...args: any[]) => any) =>
    pi.on(
      event as any,
      (async (...args: any[]) => {
        const tool = galaxyMcpToolName(args[0]?.toolName);
        if (
          !tool ||
          !["tool_call", "tool_result", "tool_execution_start", "tool_execution_end"].includes(
            event,
          )
        )
          return handler(...args);
        const connection = resolveGalaxyConnection(galaxyMcpServerName(args[0].toolName));
        if (tool === "connect" && event === "tool_call") {
          const url = args[0].input?.url ?? args[0].input?.galaxy_url;
          if (url && String(url).replace(/\/+$/, "") !== connection.url)
            return {
              block: true,
              reason:
                "A Galaxy connection cannot be rebound to another server. Add a named profile instead.",
            };
          if (args[0].input?.api_key || args[0].input?.apiKey)
            return {
              block: true,
              reason:
                "Configure the key in the named Galaxy profile; connection credentials are isolated.",
            };
        }
        let verified = connection;
        if (listGalaxyConnections().length > 1) {
          try {
            verified = await verifyGalaxyAccount(connection);
          } catch (error) {
            if (event === "tool_call") return { block: true, reason: (error as Error).message };
            // Preserve an accepted receipt even if the account lookup is now down.
          }
        }
        return withGalaxyConnection(verified, () =>
          handler({ ...args[0], toolName: `mcp__galaxy__${tool}` }, ...args.slice(1)),
        );
      }) as any,
    )) as ExtensionAPI["on"];
  scoped.registerTool = ((definition: any) => {
    if (definition.name === "galaxy_connections" || !definition.name.startsWith("galaxy_"))
      return pi.registerTool(definition);
    const execute = definition.execute;
    pi.registerTool({
      ...definition,
      parameters: {
        ...definition.parameters,
        properties: {
          ...definition.parameters.properties,
          server_id: {
            type: "string",
            description:
              "Galaxy connection name or ID. Required when referring to a run outside the default server.",
          },
        },
      },
      execute: async (...args: any[]) => {
        const connection = await verifyGalaxyAccount(
          resolveGalaxyConnection(args[1]?.server_id),
          args[2],
        );
        return withGalaxyConnection(connection, () => execute(...args));
      },
    });
  }) as ExtensionAPI["registerTool"];
  return scoped;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
