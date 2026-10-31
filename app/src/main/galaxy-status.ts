import type { OrbitConfig } from "./config.js";
import { resolveGalaxyCredentials } from "../../../shared/galaxy-credentials.js";
import { normalizeGalaxyUrl } from "../../../shared/galaxy-url.js";

export interface GalaxyStatus {
  /** True when the brain has a usable Galaxy connection (a URL *and* a key). */
  connected: boolean;
  /** The effective server URL, or null when none is resolvable. */
  url: string | null;
}

/**
 * The Galaxy server the brain is handed, resolved exactly as agent.ts
 * `buildSecretEnv` resolves it: the active profile with a readable key, else an
 * exported `GALAXY_URL` + `GALAXY_API_KEY` pair. When neither is usable the URL
 * still falls back to the profile's, then `GALAXY_URL`, so the footer can name
 * the server that isn't connected. Shared by the footer status resolver and
 * the open-history origin pin so both agree with the brain (#284, #290).
 *
 * `resolveKey` is injected (the caller passes the safeStorage-backed
 * `resolveGalaxyApiKey`) so this stays a pure, Electron-free unit.
 */
export function resolveGalaxyServerUrl(
  cfg: OrbitConfig,
  env: NodeJS.ProcessEnv,
  resolveKey: (c: OrbitConfig) => string | null,
): string | null {
  return resolveGalaxyStatus(cfg, env, resolveKey).url;
}

/**
 * Effective Galaxy connection state as the brain actually sees it. The brain
 * treats Galaxy as connected when `GALAXY_URL` and `GALAXY_API_KEY` are both
 * present in its env, and Orbit only ever hands it both from one source.
 *
 * The footer status dot reads this instead of the masked config alone, so an
 * env-driven / auto-connect session that never saved a profile still reads
 * connected -- previously the dot stayed "not configured" even though the URL
 * was known and tool calls worked (#284).
 */
export function resolveGalaxyStatus(
  cfg: OrbitConfig,
  env: NodeJS.ProcessEnv,
  resolveKey: (c: OrbitConfig) => string | null,
): GalaxyStatus {
  const creds = resolveGalaxyCredentials({
    config: cfg,
    profileApiKey: resolveKey(cfg),
    env,
    prefer: "profile",
  });
  if (creds) return { connected: true, url: creds.url };
  const active = cfg.galaxy?.active;
  const profileUrl = active ? cfg.galaxy?.profiles?.[active]?.url : undefined;
  const url = profileUrl || env.GALAXY_URL;
  return { connected: false, url: url ? normalizeGalaxyUrl(url) || null : null };
}

/**
 * Decide whether a renderer-requested history URL is safe to open externally,
 * returning the normalized URL string to open or null to reject. The
 * destination must be http(s), end in the canonical `/histories/view` path,
 * and share an origin with the effective Galaxy server (`serverUrl`, resolved
 * via resolveGalaxyServerUrl so an env-driven session pins correctly -- #290).
 * The origin pin is the real trust boundary; the path suffix is a sanity check.
 * `pathname.endsWith` (not ===) keeps subpath deployments
 * (https://example.org/galaxy/histories/view) acceptable. Pure so the trust
 * boundary is unit-testable without Electron.
 */
export function resolveGalaxyHistoryOpenUrl(
  requestedUrl: unknown,
  serverUrl: string | null,
): string | null {
  if (typeof requestedUrl !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(requestedUrl);
  } catch {
    return null;
  }
  const httpScheme = parsed.protocol === "https:" || parsed.protocol === "http:";
  if (!httpScheme || !parsed.pathname.endsWith("/histories/view")) return null;
  if (!serverUrl) return null;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(serverUrl).origin;
  } catch {
    return null;
  }
  if (parsed.origin !== expectedOrigin) return null;
  return parsed.toString();
}
