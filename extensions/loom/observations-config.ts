/**
 * Mode and install-token state for the observation collector.
 *
 * Split out of observations.ts so the privacy gate is one small file that can
 * be read end to end. Three rules hold here:
 *
 *  - `ask` is the default. A fresh install collects nothing silently.
 *  - The env var is a ONE-WAY hard disable. `ORBIT_OBSERVATIONS=off` wins over
 *    any config, and no env value turns collection on -- otherwise an ambient
 *    variable in a container or a shell profile could start data collection
 *    the user never agreed to. That is the deliberate difference from
 *    LOOM_SESSION_INDEX, which reads "1" as on.
 *  - Writes are fail-closed, exactly like tester-id-command.ts: loadConfig()
 *    silently returns {} for an unreadable config, so writing that back would
 *    wipe the user's API keys. Refuse instead.
 */

import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { getConfigPath, loadConfig, saveConfig } from "./config.js";
import { envNames } from "../../shared/orbit-env.js";

export type ObservationsMode = "off" | "ask" | "auto";

const DEFAULT_MODE: ObservationsMode = "ask";
const INSTALL_TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * The managed-deployment kill switch. Only "off" means anything. Every spelling
 * is checked rather than going through readEnv, which returns the first one
 * that is SET -- an ambient ORBIT_OBSERVATIONS=auto would otherwise mask a
 * LOOM_OBSERVATIONS=off a deployment put there on purpose.
 */
export function isObservationsHardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envNames("OBSERVATIONS").some((name) => env[name]?.trim().toLowerCase() === "off");
}

export function resolveObservationsMode(): ObservationsMode {
  if (isObservationsHardDisabled()) return "off";
  const mode = loadConfig().observations?.mode;
  if (mode === "off" || mode === "ask" || mode === "auto") return mode;
  return DEFAULT_MODE;
}

/**
 * Load the config for a write, refusing when the file exists but cannot be
 * parsed. Shared by every writer here so none of them can clobber keys.
 */
function loadConfigForWrite(): ReturnType<typeof loadConfig> {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      throw new Error(
        "The Loom config couldn't be read, so it wasn't changed -- fix or remove the file and try again.",
        { cause: err },
      );
    }
  }
  return loadConfig();
}

function persist(
  mutate: (block: NonNullable<ReturnType<typeof loadConfig>["observations"]>) => void,
): void {
  const cfg = loadConfigForWrite();
  const block = { ...(cfg.observations ?? {}) };
  mutate(block);
  cfg.observations = block;
  try {
    saveConfig(cfg);
  } catch (err) {
    throw new Error(
      "Couldn't write the Loom config -- check file permissions and free space, then try again.",
      { cause: err },
    );
  }
}

export function setObservationsMode(mode: ObservationsMode): void {
  if (isObservationsHardDisabled()) {
    throw new Error(
      "Observations are hard-disabled for this install (ORBIT_OBSERVATIONS=off), so the mode can't be changed here.",
    );
  }
  persist((block) => {
    block.mode = mode;
  });
}

export function peekInstallToken(): string | undefined {
  const token = loadConfig().observations?.installToken;
  return typeof token === "string" && INSTALL_TOKEN_RE.test(token) ? token : undefined;
}

/**
 * The per-install pseudonym, generated on first need rather than at startup --
 * a user who never leaves `off` never gets one written to disk.
 */
export function getOrCreateInstallToken(): string {
  const existing = peekInstallToken();
  if (existing) return existing;
  const token = randomBytes(16).toString("hex");
  persist((block) => {
    block.installToken = token;
  });
  return token;
}

export function hasAcknowledgedAuto(): boolean {
  return typeof loadConfig().observations?.autoAcknowledgedAt === "string";
}

export function markAutoAcknowledged(): void {
  persist((block) => {
    block.autoAcknowledgedAt = new Date().toISOString();
  });
}
