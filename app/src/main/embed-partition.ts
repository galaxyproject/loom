/**
 * Trust-boundary helpers for the locked-down Galaxy embed iframe partition.
 *
 * The notebook "Galaxy" view loads `/published/page?embed=true` in a dedicated
 * Electron partition (`persist:galaxy-embed`). Main injects the scoped embed
 * token into requests bound for the Galaxy origin — and ONLY that origin — so a
 * hijacked or off-origin request can never carry the credential. These pure,
 * Electron-free predicates are the actual trust boundary; the session wiring in
 * embed-partition-session.ts just plumbs Electron's webRequest hooks into them.
 * Pure so the boundary is unit-testable without Electron (mirrors the
 * origin-pin in galaxy-status.ts `resolveGalaxyHistoryOpenUrl`).
 *
 * The injected credential is the scoped embed token, NEVER the API key — an
 * exfiltrated token is one page, read-only, for minutes (LOOM plan §6).
 */

/** Request header carrying the scoped embed token to Galaxy. */
export const EMBED_TOKEN_HEADER = "X-Galaxy-Embed-Token";

/** Dedicated, persistent partition for the embed iframe — isolated from the
 *  app's normal session so cookies/storage never mix. */
export const GALAXY_EMBED_PARTITION = "persist:galaxy-embed";

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * True when `requestUrl` targets the same http(s) origin as the effective Galaxy
 * server — the only requests that may carry the embed token / have frame
 * headers stripped. False when the server URL is unknown, either URL is
 * unparseable, or the schemes/origins differ.
 */
export function sameGalaxyOrigin(requestUrl: string, serverUrl: string | null): boolean {
  if (!serverUrl) return false;
  const reqOrigin = originOf(requestUrl);
  const serverOrigin = originOf(serverUrl);
  return reqOrigin !== null && reqOrigin === serverOrigin;
}

/**
 * Whether an in-iframe navigation to `requestUrl` should be blocked (the caller
 * filters to main/sub-frame navigations). Fails closed: an http(s) navigation
 * off the Galaxy origin, an http(s) navigation when the server is unknown, or an
 * unparseable URL is blocked. Non-http(s) schemes (about:, blob:, data:) are
 * left alone — they aren't navigations to another host and blocking them would
 * break frame initialization.
 */
export function shouldBlockNavigation(requestUrl: string, serverUrl: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return true; // unparseable navigation → block (fail closed)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return !sameGalaxyOrigin(requestUrl, serverUrl);
}

/**
 * Drop frame-busting response headers (`X-Frame-Options` and any CSP, incl.
 * report-only) so the page renders inside our iframe. Defensive — Galaxy already
 * omits these for `embed=true` — and applied only to Galaxy-origin responses by
 * the caller. Returns a new header record; the input is untouched.
 */
export function stripFrameHeaders(
  headers: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (/^x-frame-options$/i.test(key)) continue;
    if (/^content-security-policy(-report-only)?$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
