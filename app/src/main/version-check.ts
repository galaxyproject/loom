import { app, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isNewer } from "../../../shared/version-compare.js";
import { loadConfig } from "../../../shared/loom-config.js";

const RELEASES_API = "https://api.github.com/repos/galaxyproject/loom/releases/latest";
const RELEASES_PAGE = "https://github.com/galaxyproject/loom/releases/latest";
const CACHE_FILE = path.join(os.homedir(), ".orbit", "version-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Shorter back-off for failed fetches so a flaky network at startup doesn't
// hide a real release for 24h, but rate-limit or outage scenarios don't
// re-hammer GitHub every session either.
const FAILURE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface VersionCheckResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl: string;
}

// Discriminated union: a success entry carries latest/releaseUrl; a failure
// entry just records when the attempt failed so checkLatestVersion can
// short-circuit until FAILURE_TTL_MS elapses.
type CacheShape =
  | { fetchedAt: number; failed: true }
  | { fetchedAt: number; failed?: false; latest: string; releaseUrl: string };

function readCache(): CacheShape | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const parsed: Record<string, unknown> = JSON.parse(raw);
    const fetchedAt = parsed.fetchedAt;
    if (typeof fetchedAt !== "number") return null;
    const failed = parsed.failed === true;
    if (Date.now() - fetchedAt > (failed ? FAILURE_TTL_MS : CACHE_TTL_MS)) return null;
    if (failed) return { fetchedAt, failed: true };
    const { latest, releaseUrl } = parsed;
    if (typeof latest !== "string" || typeof releaseUrl !== "string") return null;
    return { fetchedAt, latest, releaseUrl };
  } catch {
    return null;
  }
}

function writeCacheEntry(entry: CacheShape): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry));
  } catch {}
}

async function fetchLatestFromGitHub(): Promise<{ latest: string; releaseUrl: string } | null> {
  // net.fetch routes through Chromium's networking stack — works with the
  // user's system proxy/certs and doesn't require importing the Node https
  // module here. AbortSignal.timeout caps a hung request.
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Orbit/${app.getVersion()}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string; html_url?: string };
    if (typeof body.tag_name !== "string") return null;
    return {
      latest: body.tag_name,
      releaseUrl: typeof body.html_url === "string" ? body.html_url : RELEASES_PAGE,
    };
  } catch {
    return null;
  }
}

export async function checkLatestVersion(): Promise<VersionCheckResult | null> {
  if (loadConfig().updateCheck === false) return null;
  const current = app.getVersion();
  const cached = readCache();
  if (cached?.failed) return null;
  let latest: string;
  let releaseUrl: string;
  if (cached) {
    latest = cached.latest;
    releaseUrl = cached.releaseUrl;
  } else {
    const fetched = await fetchLatestFromGitHub();
    if (!fetched) {
      writeCacheEntry({ fetchedAt: Date.now(), failed: true });
      return null;
    }
    latest = fetched.latest;
    releaseUrl = fetched.releaseUrl;
    writeCacheEntry({ fetchedAt: Date.now(), latest, releaseUrl });
  }
  return {
    current,
    latest: latest.replace(/^v/, ""),
    hasUpdate: isNewer(current, latest),
    releaseUrl,
  };
}
