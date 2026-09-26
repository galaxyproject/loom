// CLI-owned update-check helper. Queries the npm registry for the newest
// version on the user's channel, caches the answer in the state dir, and exposes a
// notice string for the CLI-shell glue extension to surface in-session. The
// network refresh runs as a detached child (see bin/loom.js) so it never
// blocks startup or is killed mid-write. Pure helpers (parseCache, noticeFor)
// are unit-tested; the I/O wrappers are thin.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { isNewer, pickChannel } from "../shared/version-compare.js";
import { resolveCliVersionCheckPath } from "../shared/state-dir.js";

const PKG = "@galaxyproject/loom";
const REGISTRY = "https://registry.npmjs.org/@galaxyproject/loom";
// Loom is being renamed Orbit. The new package name is claimed with a 0.0.0
// placeholder, so only a real release there means "moved".
const ORBIT_PKG = "@galaxyproject/orbit";
const ORBIT_REGISTRY = "https://registry.npmjs.org/@galaxyproject/orbit";
const ORBIT_PLACEHOLDER = "0.0.0";
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

// This file lives at <pkg>/bin/update-check.js, so the package root is one up.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {string} the installed Loom version, from this package's package.json. */
export function getLoomVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"));
  return pkg.version;
}

/**
 * @typedef {{ fetchedAt: number, failed: true } | { fetchedAt: number, failed?: false, latest: string, channel: string, orbitLatest?: string }} Cache
 */

/** Parse + TTL-validate a cache file's contents. Pure.
 * @param {string} raw @param {number} now @returns {Cache | null} */
export function parseCache(raw, now) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.fetchedAt !== "number") return null;
  const failed = parsed.failed === true;
  if (now - parsed.fetchedAt > (failed ? FAILURE_TTL_MS : SUCCESS_TTL_MS)) return null;
  if (failed) return { fetchedAt: parsed.fetchedAt, failed: true };
  if (typeof parsed.latest !== "string" || typeof parsed.channel !== "string") return null;
  /** @type {Cache} */
  const entry = { fetchedAt: parsed.fetchedAt, latest: parsed.latest, channel: parsed.channel };
  if (typeof parsed.orbitLatest === "string") entry.orbitLatest = parsed.orbitLatest;
  return entry;
}

/** Build the notice string, or null if up to date / no usable cache. Pure.
 * @param {string} current @param {Cache | null} cache @returns {string | null} */
export function noticeFor(current, cache) {
  if (!cache || cache.failed) return null;
  if (cache.orbitLatest && isNewer(ORBIT_PLACEHOLDER, cache.orbitLatest)) {
    return `Loom is now Orbit -- \`npm i -g ${ORBIT_PKG}\``;
  }
  if (!isNewer(current, cache.latest)) return null;
  return `loom ${cache.latest} is available (you have ${current}) -- run: npm i -g ${PKG}@${cache.channel}`;
}

/** Read + validate the cache from disk. @returns {Cache | null} */
export function readCache() {
  try {
    return parseCache(fs.readFileSync(resolveCliVersionCheckPath(), "utf-8"), Date.now());
  } catch {
    return null;
  }
}

/** The in-session notice for the current install, or null. @returns {string | null} */
export function readNotice() {
  try {
    return noticeFor(getLoomVersion(), readCache());
  } catch {
    return null;
  }
}

function writeCache(entry) {
  try {
    const file = resolveCliVersionCheckPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry));
  } catch {}
}

/** The `latest` dist-tag of @galaxyproject/orbit, or null when it isn't
 * published yet or the registry can't be reached. Never throws.
 * @param {typeof fetch} [fetchFn] @returns {Promise<string | null>} */
export async function fetchOrbitLatest(fetchFn = fetch) {
  try {
    const res = await fetchFn(ORBIT_REGISTRY, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const latest = (await res.json())?.["dist-tags"]?.latest;
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
}

/** Query the npm registry for the newest version on the install's channel and
 * cache it. Best-effort: a failure writes a short-TTL failure marker. */
export async function refreshCache() {
  if (readCache()) return; // still fresh; nothing to do
  const channel = pickChannel(getLoomVersion());
  try {
    const res = await fetch(REGISTRY, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const body = await res.json();
    // dist-tags is present in the abbreviated install manifest too, so the
    // lightweight Accept header above is enough -- no full packument needed.
    const latest = body["dist-tags"]?.[channel];
    if (typeof latest !== "string") throw new Error("no dist-tag");
    const orbitLatest = await fetchOrbitLatest();
    writeCache({ fetchedAt: Date.now(), latest, channel, ...(orbitLatest ? { orbitLatest } : {}) });
  } catch {
    writeCache({ fetchedAt: Date.now(), failed: true });
  }
}

/** Resolve how Loom was installed, for `loom update`.
 * @param {string} channel @returns {{ kind: "global" | "local" | "unknown", cmd: string | null }} */
export function detectInstall(channel) {
  // A git checkout run via tsx isn't an npm install -- don't try to npm-update it.
  if (fs.existsSync(path.join(PKG_ROOT, ".git"))) {
    return { kind: "unknown", cmd: null };
  }
  let globalRoot = "";
  try {
    globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
  } catch {}
  // Compare on a path boundary so "/x/node_modules" doesn't match a sibling
  // like "/x/node_modules-vendor/...".
  const isGlobal = Boolean(globalRoot) && PKG_ROOT.startsWith(globalRoot + path.sep);
  const flag = isGlobal ? "-g " : "";
  return {
    kind: isGlobal ? "global" : "local",
    cmd: `npm install ${flag}${PKG}@${channel}`,
  };
}

// Detached-refresh entrypoint: `node bin/update-check.js --refresh`.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv.includes("--refresh")
) {
  refreshCache().finally(() => process.exit(0));
}
