/**
 * The one spelling of a user-supplied Galaxy server URL.
 *
 * Every Galaxy client Orbit uses (galaxy-ops, the brain's own requests, the
 * desktop's current-user check) appends `/api/...` to the server root, so a
 * URL that already ends in `/api` -- what the Galaxy API docs show, and what
 * people paste -- turned every call into a `/api/api/...` 404 with nothing
 * pointing at the setting. Users also type a bare host (#264, #297).
 *
 * So: trim, default a scheme-less URL to https://, drop any query or fragment
 * (clients append to the URL as a string, so `https://host/?x=1` turned into
 * `https://host/?x=1/api/...` -- one is only ever there from pasting a browser
 * address), trailing slashes, and trailing `/api` path segments. A subpath
 * deployment (`https://example.org/galaxy/api`) keeps its prefix.
 *
 * Every shell normalizes again on the way through, so this has to be
 * idempotent. That is why every trailing `/api` goes, not just one: stripping
 * one would turn `host/api/api` into `host/api` on the first pass and `host` on
 * the next, so the footer and the requests would name different servers. The
 * cost is that a Galaxy mounted under a literal `/api` prefix can't be
 * configured -- but `host/api` is already ambiguous between that and an API
 * root, and no normalizer that accepts a pasted API root can tell them apart.
 * Only lowercase `/api` is Galaxy's API root; a prefix spelled `/API` is kept.
 *
 * Explicit schemes, including http:// for loopback, are kept as typed; whether
 * they are safe to send a key to is the validators' call, not this one's.
 */

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const HAS_HOST = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/]/;
// Only a path segment: `https://api` is a host called "api", not an API root.
const API_ROOT = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+(?:\/.*)?)\/api$/;

/**
 * @param {string} url
 * @returns {string}
 */
export function normalizeGalaxyUrl(url) {
  // Cut before trimming: whitespace in front of the `?` would otherwise be left
  // on the end for the next pass to find, and the passes would disagree.
  const trimmed = url.split(/[?#]/, 1)[0].trim();
  // A scheme-relative "//host" would otherwise become "https:////host".
  const withScheme = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
  let out = withScheme.replace(/[\s/]+$/, "");
  for (let m = API_ROOT.exec(out); m; m = API_ROOT.exec(out)) out = m[1].replace(/[\s/]+$/, "");
  // Nothing left where the host goes: say so with blank, not a bare "https:".
  return HAS_HOST.test(out) ? out : "";
}
