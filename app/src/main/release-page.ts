/**
 * Release-page URL resolution for the "update available" banner.
 *
 * The renderer never gets a generic openExternal capability -- a compromised
 * renderer could otherwise redirect the browser anywhere. So the URL handed to
 * shell.openExternal is pinned here: anything that isn't an https loom releases
 * URL collapses to the canonical /releases/latest page. Kept pure and free of
 * electron imports so it can be unit-tested.
 */

const LATEST_RELEASES_PAGE = "https://github.com/galaxyproject/loom/releases/latest";

// Anchored at the start so a look-alike host (github.com.evil.com) or a path
// that merely *contains* the releases prefix can't satisfy the pin.
const LOOM_RELEASE_URL = /^https:\/\/github\.com\/galaxyproject\/loom\/releases\//;

export function resolveReleasePageUrl(url: unknown): string {
  return typeof url === "string" && LOOM_RELEASE_URL.test(url) ? url : LATEST_RELEASES_PAGE;
}
