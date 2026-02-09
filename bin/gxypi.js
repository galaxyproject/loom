#!/usr/bin/env node

import { main } from "@mariozechner/pi-coding-agent";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve extension paths relative to this script
const extensionPath = resolve(__dirname, "../extensions/galaxy-analyst");

// pi-mcp-adapter is what teaches Pi how to use MCP servers from mcp.json
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mcpAdapterPath = dirname(require.resolve("pi-mcp-adapter/index.ts"));

// Ensure Galaxy MCP is configured before Pi starts
const agentDir = process.env.PI_CODING_AGENT_DIR
  || join(homedir(), ".pi", "agent");
const mcpConfigPath = join(agentDir, "mcp.json");

let mcpConfig = {};
if (existsSync(mcpConfigPath)) {
  mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
}

if (!mcpConfig.mcpServers?.galaxy) {
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  mcpConfig.mcpServers.galaxy = {
    command: "uvx",
    args: ["galaxy-mcp"],
  };
  mkdirSync(dirname(mcpConfigPath), { recursive: true });
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
}

// Build args: inject both extensions, pass through everything else
const args = ["-e", mcpAdapterPath, "-e", extensionPath, ...process.argv.slice(2)];

main(args);
