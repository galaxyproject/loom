/**
 * Release-page URL resolution for the "update available" banner.
 *
 * The renderer never gets a generic openExternal capability -- a compromised
 * renderer could otherwise redirect the browser anywhere. So the URL handed to
 * shell.openExternal is pinned here: anything that isn't an https github.com
 * loom (or orbit) releases URL collapses to the canonical /releases/latest page. Kept pure
 * and free of electron imports so it can be unit-tested.
 *
 * The check parses with `new URL` and inspects the *normalized* protocol, host,
 * and path rather than string-matching the raw input -- a raw prefix match lets
 * `.../releases/../issues/1` (or its `%2e%2e` encoding) satisfy the pin while
 * the browser resolves it back out of /releases/. Returning `parsed.href` means
 * what we validated is exactly what gets opened.
 */

const LATEST_RELEASES_PAGE = "https://github.com/galaxyproject/loom/releases/latest";

// Both names stay valid across the Loom -> Orbit repo rename: old links in
// the CHANGELOG keep working, and the moved notice points at the new repo.
const RELEASES_PATH_PREFIXES = ["/galaxyproject/loom/releases/", "/galaxyproject/orbit/releases/"];

export function resolveReleasePageUrl(url: unknown): string {
  if (typeof url !== "string") return LATEST_RELEASES_PAGE;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return LATEST_RELEASES_PAGE;
  }
  if (
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    RELEASES_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
  ) {
    return parsed.href;
  }
  return LATEST_RELEASES_PAGE;
}
