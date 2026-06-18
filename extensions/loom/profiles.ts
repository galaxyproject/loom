/**
 * Galaxy server profile management
 *
 * Stores named profiles in the `galaxy` section of ~/.loom/config.json.
 * Each profile holds a URL + API key. The active profile's URL is synced
 * to mcp.json's env block; the API key is referenced as the literal
 * `${GALAXY_API_KEY}` env interpolation (resolved by pi-mcp-adapter at
 * spawn time) so plaintext keys never land on disk in mcp.json.
 */

import * as fs from "fs";
import * as path from "path";
import { loadConfig, saveConfig } from "./config";
import { piAgentDir } from "./agent-dir.js";

export interface GalaxyProfile {
  url: string;
  /** Plaintext API key. Orbit migrates this to apiKeyEncrypted on next startup. */
  apiKey?: string;
  /** Base64 ciphertext produced by Electron safeStorage (Orbit-only). */
  apiKeyEncrypted?: string;
}

/**
 * Thrown when the brain process is asked to use a profile that only has
 * `apiKeyEncrypted` set. The brain runs without Electron's safeStorage,
 * so it cannot decrypt the key itself -- the shell must inject the
 * decrypted value as `GALAXY_API_KEY` in the brain's env (Orbit does
 * this in `app/src/main/agent.ts:buildSecretEnv`). When the env
 * injection is also missing, callers see this error instead of a
 * silent fallback that would 401 against Galaxy.
 */
export class EncryptedProfileUnavailableError extends Error {
  constructor(public profileName: string) {
    super(
      `Profile "${profileName}" has only an encrypted API key; this process can't decrypt it. ` +
        `Run from Orbit (auto-injects the key) or export GALAXY_API_KEY explicitly.`,
    );
    this.name = "EncryptedProfileUnavailableError";
  }
}

export interface GalaxyProfiles {
  active: string | null;
  profiles: Record<string, GalaxyProfile>;
}

export function loadProfiles(): GalaxyProfiles {
  const config = loadConfig();
  if (config.galaxy) {
    return {
      active: config.galaxy.active ?? null,
      profiles: config.galaxy.profiles ?? {},
    };
  }
  return { active: null, profiles: {} };
}

function writeProfiles(profiles: GalaxyProfiles): void {
  const config = loadConfig();
  config.galaxy = {
    active: profiles.active,
    profiles: profiles.profiles,
  };
  saveConfig(config);
}

/**
 * Derive a short profile name from a Galaxy server URL.
 * https://test.galaxyproject.org/ → "test-galaxyproject"
 * https://usegalaxy.org/ → "usegalaxy-org"
 * http://localhost:8080/ → "localhost-8080"
 */
export function profileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname;
    // Include port for non-standard ports
    if (parsed.port) {
      host += `-${parsed.port}`;
    }
    // Replace dots with hyphens, drop trailing TLD-only segments for cleaner names
    return host.replace(/\./g, "-").replace(/-+$/, "");
  } catch {
    // Fallback: slugify the whole string
    return url
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
  }
}

/**
 * Validate a candidate Galaxy server URL. The API key is sent as
 * `x-api-key` on every request; if the URL is `http://` (or otherwise
 * malformed), the key would be exposed in cleartext or land at the
 * wrong host. Reject bad URLs at save time so the user sees the
 * mistake instead of silently exfiltrating credentials.
 *
 * Hosts outside `*.galaxyproject.org` and `localhost`/`127.*` are
 * accepted but with a warning to the console — institutions run
 * private Galaxy mirrors, so an allowlist would be too narrow.
 */
/**
 * Default a scheme-less Galaxy URL to https://. Users routinely type a bare
 * host ("test.galaxyproject.org") and expect it to resolve; without this
 * `new URL()` throws and they just see "Not a valid URL." https is the right
 * default -- it's the only scheme allowed for non-loopback hosts anyway.
 * Explicit schemes (including http:// for localhost) are preserved as typed.
 */
export function normalizeGalaxyUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * True for an IPv4 loopback (127.0.0.0/8), localhost, or IPv6 ::1. A bare
 * `startsWith("127.")` would wrongly accept a resolvable hostname like
 * `127.evil.example`, which over http would leak the API key in cleartext.
 */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1";
}

export function validateGalaxyUrl(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (isLoopbackHost(host)) {
      // Loopback HTTP is fine for local Galaxy installs.
      return { ok: true };
    }
    return {
      ok: false,
      reason: "Galaxy URL must use https:// (the API key is sent on every request).",
    };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `Unsupported URL scheme: ${parsed.protocol}` };
  }
  return { ok: true };
}

/**
 * Save a profile (insert or update), mark it active, and sync to mcp.json.
 *
 * The brain process can't encrypt (no Electron safeStorage), so the
 * plaintext key lands on disk briefly. Orbit's main process watches
 * `~/.loom/config.json` and re-encrypts on change, closing the plaintext
 * window to milliseconds. CLI users without safeStorage get plaintext
 * persistence -- there's no other option, but they're warned at load time.
 */
export function saveProfile(name: string, url: string, apiKey: string): void {
  const v = validateGalaxyUrl(url);
  if (!v.ok) throw new Error(v.reason);
  const host = new URL(url).hostname.toLowerCase();
  const trusted =
    isLoopbackHost(host) || host === "galaxyproject.org" || host.endsWith(".galaxyproject.org");
  if (!trusted) {
    console.warn(
      `[galaxy] Profile "${name}" points at ${host} (not a galaxyproject.org subdomain).`,
    );
  }
  const profiles = loadProfiles();
  profiles.profiles[name] = { url, apiKey };
  profiles.active = name;
  writeProfiles(profiles);
  syncMcpConfig(url);
}

/**
 * Resolve a profile's plaintext API key for in-process use (Galaxy HTTP
 * calls inside the brain). Returns the plaintext value when available,
 * or throws `EncryptedProfileUnavailableError` for encrypted-only
 * profiles -- callers must surface that to the user rather than firing
 * the wrong key at the server.
 */
export function resolveProfileApiKey(name: string, profile: GalaxyProfile): string {
  if (profile.apiKey) return profile.apiKey;
  if (profile.apiKeyEncrypted) {
    throw new EncryptedProfileUnavailableError(name);
  }
  throw new Error(`Profile "${name}" has no API key configured.`);
}

export type ActiveGalaxyStatus = "usable" | "configured-unusable" | "none";

/**
 * Usability of the active Galaxy profile for THIS process. The startup greeting
 * reads this so its message can't contradict the actual credential state.
 *
 * - `usable`: GALAXY_URL + GALAXY_API_KEY are both in env (however they got
 *   there -- plaintext profile, explicit export, or Orbit's decrypt-inject).
 * - `configured-unusable`: no usable env key, but the active profile carries an
 *   encrypted key this process can't decrypt (Orbit-only safeStorage). Galaxy
 *   calls would 401; the fix is to run from Orbit or export GALAXY_API_KEY.
 * - `none`: no usable active profile to speak of.
 *
 * Pure given (profiles, env); `activeGalaxyStatus()` is the thin live wrapper.
 */
export function getActiveGalaxyStatus(
  profiles: GalaxyProfiles,
  env: NodeJS.ProcessEnv,
): ActiveGalaxyStatus {
  if (env.GALAXY_URL && env.GALAXY_API_KEY) return "usable";
  const active = profiles.active;
  if (!active) return "none";
  const profile = profiles.profiles[active];
  if (profile && !profile.apiKey && !env.GALAXY_API_KEY && profile.apiKeyEncrypted) {
    return "configured-unusable";
  }
  return "none";
}

export function activeGalaxyStatus(): ActiveGalaxyStatus {
  return getActiveGalaxyStatus(loadProfiles(), process.env);
}

/**
 * Switch to an existing profile. Updates active marker, syncs mcp.json,
 * and sets process.env so the current session picks it up immediately.
 *
 * Two paths for the API key:
 *   1) plaintext `apiKey` -> set env to it.
 *   2) encrypted-only -> CLEAR `process.env.GALAXY_API_KEY`. The brain
 *      can't decrypt to verify whether any value already in env matches
 *      *this* profile's ciphertext (the env was injected for whatever
 *      profile was active at brain spawn). Better to fail loud than to
 *      silently send the previous profile's key to the new URL. The
 *      shell will re-inject on the next brain restart from the now-active
 *      encrypted profile.
 */
export function switchProfile(name: string): boolean {
  const profiles = loadProfiles();
  const profile = profiles.profiles[name];
  if (!profile) return false;

  profiles.active = name;
  writeProfiles(profiles);

  process.env.GALAXY_URL = profile.url;
  if (profile.apiKey) {
    process.env.GALAXY_API_KEY = profile.apiKey;
  } else if (profile.apiKeyEncrypted) {
    // Always invalidate; let the shell restart re-inject the right value.
    delete process.env.GALAXY_API_KEY;
    console.warn(
      `[galaxy] Profile "${name}" has only an encrypted API key. Cleared ` +
        `GALAXY_API_KEY in this session; restart the shell so Orbit can ` +
        `re-inject the decrypted key for this profile.`,
    );
  }
  // mcp.json holds a literal "${GALAXY_API_KEY}" reference; pi-mcp-adapter
  // resolves it at MCP spawn time. So the only thing we sync per-profile
  // is the URL.
  syncMcpConfig(profile.url);
  return true;
}

/**
 * Remove a profile. If it was active, clears the active marker.
 */
export function deleteProfile(name: string): boolean {
  const profiles = loadProfiles();
  if (!profiles.profiles[name]) return false;

  delete profiles.profiles[name];
  if (profiles.active === name) {
    const remaining = Object.keys(profiles.profiles);
    profiles.active = remaining.length > 0 ? remaining[0] : null;
  }
  writeProfiles(profiles);
  return true;
}

/**
 * Keep mcp.json's galaxy URL in sync with the active profile.
 *
 * The API key is written as the literal `${GALAXY_API_KEY}` reference,
 * which pi-mcp-adapter (`server-manager.ts:resolveEnv`) interpolates from
 * the live process env at spawn time. That keeps plaintext keys off disk
 * in mcp.json -- the env is populated by Orbit's safeStorage decrypt or
 * by the user's explicit `export GALAXY_API_KEY=...`.
 */
export function syncMcpConfig(url: string): void {
  try {
    const mcpPath = path.join(piAgentDir(), "mcp.json");
    if (!fs.existsSync(mcpPath)) return;

    const config = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    if (config.mcpServers?.galaxy) {
      config.mcpServers.galaxy.env = {
        GALAXY_URL: url,
        GALAXY_API_KEY: "${GALAXY_API_KEY}",
      };
      // 0600 first so a concurrent reader can't catch the file with a
      // wider mode between writeFile and chmod.
      fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      try {
        fs.chmodSync(mcpPath, 0o600);
      } catch {
        /* perm-tightening best-effort */
      }
    }
  } catch {
    // Non-fatal
  }
}
