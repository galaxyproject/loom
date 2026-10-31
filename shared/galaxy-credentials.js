/**
 * Which Galaxy server and API key a brain session uses.
 *
 * The URL and the key always come from the same place. Resolving them
 * separately once paired an exported GALAXY_API_KEY with the saved profile's
 * URL -- a key for one server sent to another -- whenever the profile's own key
 * was encrypted and so unreadable by the CLI.
 *
 * Two sources:
 *   - env: GALAXY_URL and GALAXY_API_KEY, both set.
 *   - profile: the active config profile's URL plus a key for it. The CLI can
 *     only use a plaintext `apiKey`; the desktop passes the key it decrypted.
 *
 * `prefer` picks the winner when both are usable. The CLI prefers env, so
 * `GALAXY_URL=... GALAXY_API_KEY=... orbit` reaches any server without editing
 * config. The desktop prefers the profile picked in its UI, then hands the
 * brain the result as an env pair, which the brain's CLI layer takes as is.
 *
 * The URL comes back normalized (shared/galaxy-url.js), so a pasted `/api` root
 * or a bare host from either source reaches every client in one spelling.
 */

import { normalizeGalaxyUrl } from "./galaxy-url.js";

/**
 * @param {import("./galaxy-credentials.js").ResolveGalaxyCredentialsInput} input
 * @returns {import("./galaxy-credentials.js").GalaxyCredentials | null}
 */
export function resolveGalaxyCredentials({ config, profileApiKey, env, prefer }) {
  const envUrl = normalizeGalaxyUrl(env?.GALAXY_URL ?? "");
  const envKey = env?.GALAXY_API_KEY?.trim();
  const fromEnv = envUrl && envKey ? { url: envUrl, apiKey: envKey, source: "env" } : null;

  const active = config?.galaxy?.active;
  const profile = active ? config?.galaxy?.profiles?.[active] : undefined;
  const key = profileApiKey === undefined ? profile?.apiKey : profileApiKey;
  const profileUrl = normalizeGalaxyUrl(profile?.url ?? "");
  const fromProfile =
    profileUrl && key ? { url: profileUrl, apiKey: key, source: "profile" } : null;

  return prefer === "profile" ? (fromProfile ?? fromEnv) : (fromEnv ?? fromProfile);
}

/**
 * Why an exported env pair wasn't used, or why nothing resolved, when the
 * cause is something the user should hear about -- a half-set env pair, or a
 * profile whose key only Orbit desktop can read. Null when there's nothing to
 * say, including when nothing Galaxy-related is configured at all.
 *
 * @param {Pick<import("./galaxy-credentials.js").ResolveGalaxyCredentialsInput, "config" | "env">} input
 * @returns {string | null}
 */
export function describeMissingGalaxyCredentials({ config, env }) {
  const envUrl = env?.GALAXY_URL?.trim();
  const envKey = env?.GALAXY_API_KEY?.trim();
  if (envKey && !envUrl) {
    return "GALAXY_API_KEY is set without GALAXY_URL, so it was ignored. Set both to choose a server.";
  }
  if (envUrl && !envKey) {
    return "GALAXY_URL is set without GALAXY_API_KEY, so it was ignored. Set both to choose a server.";
  }
  const active = config?.galaxy?.active;
  const profile = active ? config?.galaxy?.profiles?.[active] : undefined;
  if (profile?.url && !profile.apiKey && profile.apiKeyEncrypted) {
    return (
      `The active Galaxy profile "${active}" (${profile.url}) has a key only Orbit desktop can ` +
      "decrypt. Export GALAXY_URL and GALAXY_API_KEY, or run /connect."
    );
  }
  return null;
}
