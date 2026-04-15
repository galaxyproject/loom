/**
 * Consolidated config file for gxypi (~/.gxypi/config.json)
 *
 * Single source of truth for user-facing configuration: Galaxy server
 * profiles and LLM provider settings. Both sections are optional —
 * missing keys fall back to env vars / legacy files.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface GxypiConfig {
  llm?: {
    provider?: string;
    apiKey?: string;
    model?: string;
  };
  galaxy?: {
    active: string | null;
    profiles: Record<string, { url: string; apiKey: string }>;
  };
  /**
   * Execution mode the shell/CLI is in.
   * - "remote": Galaxy tools are exposed to the agent (default, Galaxy-native first).
   * - "local": Galaxy MCP is not registered; this is a planning/review-only mode
   *   until a local execution primitive is wired up.
   */
  executionMode?: "local" | "remote";
}

export function getConfigDir(): string {
  return path.join(os.homedir(), ".gxypi");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function loadConfig(): GxypiConfig {
  const p = getConfigPath();
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

export function saveConfig(config: GxypiConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}
