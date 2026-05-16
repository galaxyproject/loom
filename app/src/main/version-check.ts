import { app, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const RELEASES_API = "https://api.github.com/repos/galaxyproject/loom/releases/latest";
const RELEASES_PAGE = "https://github.com/galaxyproject/loom/releases/latest";
const CACHE_FILE = path.join(os.homedir(), ".orbit", "version-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface VersionCheckResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl: string;
}

interface CacheShape {
  fetchedAt: number;
  latest: string;
  releaseUrl: string;
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

function parseSemver(v: string): SemverParts | null {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    pre: m[4] ?? "",
  };
}

// Lex-compares prerelease tags. Semver spec is stricter (dot-separated
// identifiers, numeric vs alpha rules), but for our alpha.N / beta.N / rc.N
// tag scheme a string compare gives the right ordering and avoids pulling
// in a semver dependency for one feature.
function isNewer(current: string, candidate: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  if (b.minor !== a.minor) return b.minor > a.minor;
  if (b.patch !== a.patch) return b.patch > a.patch;
  if (a.pre && !b.pre) return true;
  if (!a.pre && b.pre) return false;
  if (a.pre && b.pre) return b.pre > a.pre;
  return false;
}

function readCache(): CacheShape | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as CacheShape;
    if (typeof parsed.fetchedAt !== "number") return null;
    if (typeof parsed.latest !== "string") return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(latest: string, releaseUrl: string): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ fetchedAt: Date.now(), latest, releaseUrl } satisfies CacheShape),
    );
  } catch {}
}

async function fetchLatestFromGitHub(): Promise<{ latest: string; releaseUrl: string } | null> {
  // net.fetch routes through Chromium's networking stack — works with the
  // user's system proxy/certs and doesn't require importing the Node https
  // module here. AbortSignal.timeout caps a hung request.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Orbit/${app.getVersion()}`,
      },
      signal: controller.signal,
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
  } finally {
    clearTimeout(t);
  }
}

export async function checkLatestVersion(): Promise<VersionCheckResult | null> {
  const current = app.getVersion();
  const cached = readCache();
  let latest: string;
  let releaseUrl: string;
  if (cached) {
    latest = cached.latest;
    releaseUrl = cached.releaseUrl;
  } else {
    const fetched = await fetchLatestFromGitHub();
    if (!fetched) return null;
    latest = fetched.latest;
    releaseUrl = fetched.releaseUrl;
    writeCache(latest, releaseUrl);
  }
  return {
    current,
    latest: latest.replace(/^v/, ""),
    hasUpdate: isNewer(current, latest),
    releaseUrl,
  };
}
