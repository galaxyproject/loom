import { loadConfig, saveConfig } from "../../../shared/loom-config.js";
import type { GuardianConfig } from "./types";

export function loadGuardianConfig(): GuardianConfig {
  const g = loadConfig().guardian ?? {};
  return {
    enabled: g.enabled !== false,
    dangerouslyBypassPermissions: g.dangerouslyBypassPermissions === true,
    trustedWorkspaces: g.trustedWorkspaces ?? [],
    extraWorkspaceRoots: g.extraWorkspaceRoots ?? [],
    consentAcknowledged: g.consentAcknowledged ?? null,
    sandbox: g.sandbox === true,
  };
}

/**
 * Bypass is ON if (env flag OR config) AND NOT force-off. The agent can never
 * flip the env or config: those are human-only channels (the gate makes
 * writing ~/.loom/config.json gated and editing guardian.* catastrophic).
 */
export function resolveBypass(cfg: GuardianConfig): boolean {
  if (process.env.LOOM_SAFE === "1") return false;
  if (process.env.LOOM_DANGEROUSLY_BYPASS_PERMISSIONS === "1") return true;
  return cfg.dangerouslyBypassPermissions === true;
}

/**
 * The OS bash sandbox is opt-in: enabling it necessarily restricts bash network
 * (ASRT cannot confine writes alone), so it's a deliberate user choice, not a
 * default. On via LOOM_SANDBOX=1 or guardian.sandbox. Default off.
 */
export function resolveSandbox(cfg: GuardianConfig): boolean {
  if (process.env.LOOM_SANDBOX === "1") return true;
  return cfg.sandbox === true;
}

export function trustWorkspace(dir: string): void {
  const cfg = loadConfig();
  const g = cfg.guardian ?? {};
  const set = new Set(g.trustedWorkspaces ?? []);
  set.add(dir);
  cfg.guardian = { ...g, trustedWorkspaces: [...set] };
  saveConfig(cfg);
}

export function recordConsent(version: string): void {
  const cfg = loadConfig();
  cfg.guardian = {
    ...(cfg.guardian ?? {}),
    consentAcknowledged: { version, at: new Date().toISOString() },
  };
  saveConfig(cfg);
}
