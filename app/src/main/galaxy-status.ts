import type { LoomConfig } from "./config.js";

export interface GalaxyStatus {
  /** True when the brain has a usable Galaxy connection (a URL *and* a key). */
  connected: boolean;
  /** The effective server URL, or null when none is resolvable. */
  url: string | null;
}

/**
 * The effective Galaxy server URL with the same precedence the brain's env
 * uses: the active config profile's URL wins, else an exported `GALAXY_URL`,
 * else null. Shared by the footer status resolver and the open-history origin
 * pin so both agree on which server an env-driven session is actually talking
 * to -- deriving it from the masked config profile alone missed the env-driven
 * / auto-connect path (#290, follow-up to #284).
 */
export function resolveGalaxyServerUrl(cfg: LoomConfig, env: NodeJS.ProcessEnv): string | null {
  const active = cfg.galaxy?.active;
  const profileUrl = active ? cfg.galaxy?.profiles?.[active]?.url : undefined;
  return profileUrl || env.GALAXY_URL || null;
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
  const url = resolveGalaxyServerUrl(cfg, env);
  const key = resolveKey(cfg) ?? env.GALAXY_API_KEY ?? null;
  return { connected: Boolean(url && key), url };
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

/** Restrict activity links to the configured deployment and known read-only pages. */
export function resolveGalaxyActivityOpenUrl(
  requestedUrl: unknown,
  serverUrl: string | null,
): string | null {
  if (typeof requestedUrl !== "string" || !serverUrl) return null;
  try {
    const target = new URL(requestedUrl);
    const server = new URL(serverUrl);
    if (
      !["https:", "http:"].includes(server.protocol) ||
      target.origin !== server.origin ||
      target.username ||
      target.password
    )
      return null;
    const base = server.pathname.replace(/\/+$/, "");
    const path = target.pathname.slice(base.length);
    if (!target.pathname.startsWith(`${base}/`)) return null;
    if (path === "/histories/view" && /^[a-f0-9]+$/i.test(target.searchParams.get("id") || ""))
      return target.toString();
    if (/^\/workflows\/invocations\/[a-f0-9]+$/i.test(path) && !target.search)
      return target.toString();
    if (path === "/" && !target.search) return target.toString();
  } catch {
    /* invalid URL */
  }
  return null;
}
