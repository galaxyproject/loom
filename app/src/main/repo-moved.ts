/**
 * "Loom is now Orbit" detection for the desktop app.
 *
 * Installed builds ask update.electronjs.org about `galaxyproject/loom` forever,
 * and nobody knows whether that survives the GitHub repo rename. This check is
 * the safety net: it asks the GitHub API about the old repo and, once GitHub
 * answers with a different `full_name` (it 301s renamed repos to the new
 * one), points the user at the new repo's latest release.
 *
 * The overriding rule is no false positives. Only an affirmative answer from
 * GitHub counts as "moved": a 200 whose full_name differs, or a GitHub-shaped
 * 404 for the old repo *plus* a 200 for galaxyproject/orbit. Anything else --
 * offline, timeouts, 403/429 rate limits, 5xx, a proxy's HTML page, malformed
 * JSON -- is "unknown" and never shows the notice.
 *
 * Kept free of electron imports (fetch is injected) so it can be unit-tested.
 */

export const OLD_REPO = "galaxyproject/loom";
// The planned new name. Only consulted when the old repo 404s, since then
// GitHub gives us no redirect to learn the new name from.
export const EXPECTED_NEW_REPO = "galaxyproject/orbit";

const API = "https://api.github.com/repos/";

export interface RepoMovedInfo {
  fullName: string;
  latest: string | null;
  releaseUrl: string;
}

export type RepoMovedOutcome =
  { kind: "not-moved" } | { kind: "moved"; info: RepoMovedInfo } | { kind: "unknown" };

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const FULL_NAME_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function isFullName(v: unknown): v is string {
  return typeof v === "string" && FULL_NAME_RE.test(v);
}

function latestReleasePage(fullName: string): string {
  return `https://github.com/${fullName}/releases/latest`;
}

async function readJson(res: {
  json(): Promise<unknown>;
}): Promise<Record<string, unknown> | null> {
  try {
    const body = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type RepoLookup = { kind: "found"; fullName: string } | { kind: "missing" } | { kind: "unknown" };

async function lookupRepo(fetchFn: FetchLike, fullName: string): Promise<RepoLookup> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(API + fullName);
  } catch {
    return { kind: "unknown" };
  }
  const body = await readJson(res);
  if (res.ok) {
    return body && isFullName(body.full_name)
      ? { kind: "found", fullName: body.full_name }
      : { kind: "unknown" };
  }
  // Only GitHub's own JSON "Not Found" counts as missing; a captive portal or
  // proxy that 404s with HTML must not read as a deleted repo.
  if (res.status === 404 && body && body.message === "Not Found") return { kind: "missing" };
  return { kind: "unknown" };
}

async function latestRelease(
  fetchFn: FetchLike,
  fullName: string,
): Promise<{ latest: string | null; releaseUrl: string }> {
  const fallback = { latest: null, releaseUrl: latestReleasePage(fullName) };
  try {
    const res = await fetchFn(`${API}${fullName}/releases/latest`);
    if (!res.ok) return fallback;
    const body = await readJson(res);
    if (!body) return fallback;
    const latest = typeof body.tag_name === "string" ? body.tag_name : null;
    const releaseUrl =
      typeof body.html_url === "string" &&
      body.html_url.startsWith(`https://github.com/${fullName}/releases/`)
        ? body.html_url
        : fallback.releaseUrl;
    return { latest, releaseUrl };
  } catch {
    return fallback;
  }
}

export async function detectRepoMoved(fetchFn: FetchLike): Promise<RepoMovedOutcome> {
  const old = await lookupRepo(fetchFn, OLD_REPO);
  let newName: string;
  if (old.kind === "found") {
    if (old.fullName.toLowerCase() === OLD_REPO) return { kind: "not-moved" };
    newName = old.fullName;
  } else if (old.kind === "missing") {
    const next = await lookupRepo(fetchFn, EXPECTED_NEW_REPO);
    if (next.kind !== "found" || next.fullName.toLowerCase() !== EXPECTED_NEW_REPO) {
      return { kind: "unknown" };
    }
    newName = next.fullName;
  } else {
    return { kind: "unknown" };
  }
  const rel = await latestRelease(fetchFn, newName);
  return { kind: "moved", info: { fullName: newName, ...rel } };
}

/**
 * Dev/test override so the banner can be looked at without a real rename.
 * "1"/"true" fakes a move to galaxyproject/orbit; an owner/repo value fakes a
 * move to that repo. Anything else is ignored.
 */
export function forcedRepoMoved(value: string | undefined): RepoMovedInfo | null {
  if (!value) return null;
  const v = value.trim();
  const fullName = v === "1" || v.toLowerCase() === "true" ? EXPECTED_NEW_REPO : v;
  if (!isFullName(fullName)) return null;
  return { fullName, latest: "v0.9.0", releaseUrl: latestReleasePage(fullName) };
}
