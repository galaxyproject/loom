/**
 * The MCP servers Loom brings with it, registered with pi's built-in MCP support.
 *
 * Registrations live only in this session, so the brain registers on every load.
 * /connect switches profiles by setting GALAXY_URL/GALAXY_API_KEY and reloading,
 * so the Galaxy entry tracks the active profile without any file to keep in sync.
 */

import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { GALAXY_MCP_SPEC } from "../../shared/galaxy-mcp-spec.js";

export function loomMcpServers(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  if (env.GALAXY_URL && env.GALAXY_API_KEY) {
    servers.galaxy = {
      command: "uvx",
      args: [GALAXY_MCP_SPEC],
      exposure: "direct",
      // Local-path upload over MCP times out on large files (-32001); the
      // loom-native galaxy_upload_local_file tool handles those instead. URL
      // upload (upload_file_from_url) and the rest stay exposed.
      toolExposure: { upload_file: "hidden" },
      // The MCP default of 60s is routinely outrun by a public Galaxy under
      // load (job submission, dataset detail lookups). Progress notifications
      // reset this, so it only bounds a call that has gone quiet.
      timeout: 300,
      // References, not values: pi resolves them at spawn, and the key never
      // lands in /mcp's config view or a /bug report.
      env: {
        GALAXY_URL: "${GALAXY_URL}",
        GALAXY_API_KEY: "${GALAXY_API_KEY}",
      },
    };
  }

  // Public, anonymous BRC genome/assembly/lineage lookups -- no credentials, so
  // always on.
  servers["brc-analytics"] = {
    url: "https://brc-analytics.org/api/v1/mcp/",
    exposure: "direct",
  };

  return servers;
}

export function registerLoomMcpServers(pi: ExtensionAPI): void {
  for (const [name, config] of Object.entries(loomMcpServers())) {
    pi.registerMcpServer(name, config);
  }
}
