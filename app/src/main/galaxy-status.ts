import type { LoomConfig } from "./config.js";

export interface GalaxyStatus {
  /** True when the brain has a usable Galaxy connection (a URL *and* a key). */
  connected: boolean;
  /** The effective server URL, or null when none is resolvable. */
  url: string | null;
}

/**
 * Effective Galaxy connection state as the brain actually sees it. The brain
 * treats Galaxy as connected when `GALAXY_URL` and `GALAXY_API_KEY` are both
 * present in its env (extensions/loom/context.ts), and Orbit builds that env
 * with the same precedence used here: the active config profile wins, else a
 * value exported into Orbit's own environment (agent.ts `buildSecretEnv`).
 *
 * The footer status dot reads this instead of the masked config alone, so an
 * env-driven / auto-connect session that never saved a profile still reads
 * connected -- previously the dot stayed "not configured" even though the URL
 * was known and tool calls worked (#284).
 *
 * `resolveKey` is injected (the caller passes the safeStorage-backed
 * `resolveGalaxyApiKey`) so this stays a pure, Electron-free unit.
 */
export function resolveGalaxyStatus(
  cfg: LoomConfig,
  env: NodeJS.ProcessEnv,
  resolveKey: (c: LoomConfig) => string | null,
): GalaxyStatus {
  const active = cfg.galaxy?.active;
  const profileUrl = active ? cfg.galaxy?.profiles?.[active]?.url : undefined;
  const url = profileUrl || env.GALAXY_URL || null;
  const key = resolveKey(cfg) ?? env.GALAXY_API_KEY ?? null;
  return { connected: Boolean(url && key), url };
}
