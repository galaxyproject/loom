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

/** Request cookie header — stripped so the embed partition stays stateless. */
export const COOKIE_HEADER = "Cookie";

/** Response header setting a cookie — stripped so Galaxy can't seat a session
 *  in the embed partition. */
export const SET_COOKIE_HEADER = "Set-Cookie";

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

/**
 * Drop any case-variant of header `name` from a header record. Pure; returns a
 * new record with the input untouched. Generic over the value type so it serves
 * both request headers (`string`) and response headers (`string[]`).
 *
 * Used to keep the embed partition **stateless**: the `<webview>` loading
 * `/published/page` makes Galaxy seat an anonymous `galaxysession` cookie, and
 * Galaxy resolves that cookie session ahead of the injected embed token — so a
 * cookie-bearing `/api/pages/{id}` is read as anonymous and 403s even with a
 * valid token (LOOM Bug 1). Stripping `Cookie` on Galaxy-origin requests (and
 * `Set-Cookie` on responses) means the locked-down view carries no ambient
 * session and authenticates by the per-page token alone.
 */
export function stripHeader<T>(
  headers: Record<string, T> | undefined,
  name: string,
): Record<string, T> {
  const lower = name.toLowerCase();
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower) continue;
    out[key] = value;
  }
  return out;
}
