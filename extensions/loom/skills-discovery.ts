import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { listEnabledSkillRepos, type ConfiguredSkillRepo } from "./skills";
import { hasBundledContent, isBundledRepo, readBundledCatalog } from "./vendor-skills";
export type { ConfiguredSkillRepo };

/** The product-surface id Loom claims. A skill opts in with `surfaces: [loom]`. */
export const SURFACE_ID = "loom";

/** Catalog freshness window. SKILL.md frontmatter + the tree listing use this; deep refs stay 24h. */
export const CATALOG_TTL_MS = 60 * 60 * 1000;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  when_to_use?: string;
  surfaces?: string[];
}

export interface SkillEntry {
  path: string;
  name: string;
  description: string;
  when_to_use?: string;
  surfaces: string[];
}

function toSurfaces(v: unknown): string[] {
  if (typeof v === "string") return [v.trim()].filter(Boolean);
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function parseFrontmatter(text: string): SkillFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  let data: unknown;
  try {
    data = parseYaml(m[1]);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const o = data as Record<string, unknown>;
  const fm: SkillFrontmatter = {};
  if (typeof o.name === "string") fm.name = o.name;
  if (typeof o.description === "string") fm.description = o.description;
  if (typeof o.when_to_use === "string") fm.when_to_use = o.when_to_use.trim();
  // `surfaces` is a custom (non-standard) key, so per the Agent-Skills spec it
  // lives under the `metadata` object rather than polluting the top level.
  const metadata =
    o.metadata && typeof o.metadata === "object"
      ? (o.metadata as Record<string, unknown>)
      : undefined;
  fm.surfaces = toSurfaces(metadata?.surfaces);
  return fm;
}

/** Tag-or-all: if any entry is tagged for this surface, keep only those; else keep all. */
export function selectSkills(entries: SkillEntry[], surface: string = SURFACE_ID): SkillEntry[] {
  const tagged = entries.filter((e) => e.surfaces.includes(surface));
  return tagged.length ? tagged : entries;
}

/** Short stable tag derived from `${url}@${branch}` for the skills-cache directory. */
export function createSkillsCacheTag(url: string, branch: string): string {
  return crypto.createHash("sha256").update(`${url}@${branch}`).digest("hex").slice(0, 8);
}

/** Parse a github.com repo URL into its owner/repo, or null. */
export function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const segs = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segs.length < 2 || !segs[0] || !segs[1]) return null;
  return { owner: segs[0], repo: segs[1].replace(/\.git$/i, "") };
}

/** Resolve a github.com repo URL into its raw.githubusercontent.com base, or null. */
export function githubRawBase(repoUrl: string, branch: string): string | null {
  const slug = parseGithubRepo(repoUrl);
  if (!slug) return null;
  const cleanBranch = (branch || "main").replace(/^\/+|\/+$/g, "");
  // Reject path traversal in the branch: a git ref never contains "..", and an
  // unescaped (or %2e-escaped) ".." here would walk raw.githubusercontent.com
  // out of the allowlisted owner/repo (e.g. branch "../../other/repo/main").
  let decodedBranch = cleanBranch;
  try {
    decodedBranch = decodeURIComponent(cleanBranch);
  } catch {
    // malformed escape -- fall through to the raw form for the check
  }
  if (decodedBranch.includes("..")) return null;
  return `https://raw.githubusercontent.com/${slug.owner}/${slug.repo}/${cleanBranch}`;
}

/** The on-disk cache dir for a repo: ~/.loom/cache/skills/<name>@<hash>/ */
export function skillsCacheDir(repo: ConfiguredSkillRepo): string {
  const tag = createSkillsCacheTag(repo.url, repo.branch);
  return path.join(os.homedir(), ".loom", "cache", "skills", `${repo.name}@${tag}`);
}

export type FetchSkillResult =
  { ok: true; text: string; cached: boolean } | { ok: false; status?: number; error: string };

/**
 * Fetch one file from a skills repo, reading/writing the same on-disk cache the
 * `skills_fetch` tool uses. SKILL.md files use the 1h catalog TTL (they ARE the
 * catalog); everything else (deep reference docs) keeps the 24h content TTL.
 * `cleanPath` must already be normalized (no leading slash, no `..`).
 */
export async function fetchSkillFile(
  repo: ConfiguredSkillRepo,
  cleanPath: string,
  signal?: AbortSignal,
  force = false,
): Promise<FetchSkillResult> {
  const rawBase = githubRawBase(repo.url, repo.branch);
  if (!rawBase) return { ok: false, error: `Repo URL "${repo.url}" is not a GitHub repo URL.` };

  const cachePath = path.join(skillsCacheDir(repo), cleanPath);
  const ttlMs = cleanPath.endsWith("SKILL.md") ? CATALOG_TTL_MS : 24 * 60 * 60 * 1000;
  if (!force) {
    try {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < ttlMs) {
        return { ok: true, text: fs.readFileSync(cachePath, "utf-8"), cached: true };
      }
    } catch {
      // cache miss -- fall through to fetch
    }
  }

  // Encode each path segment -- a SKILL.md path could contain URL-significant
  // characters (#, ?) that would otherwise corrupt the request.
  const encodedPath = cleanPath.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await fetch(`${rawBase}/${encodedPath}`, { signal });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  const text = await response.text();
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, text, "utf-8");
  } catch (err) {
    console.error("[skills] cache write failed:", err);
  }
  return { ok: true, text, cached: false };
}

/** List every SKILL.md path in a repo via the GitHub trees API. Throws on HTTP failure. */
export async function treeWalkSkillPaths(
  repo: ConfiguredSkillRepo,
  signal?: AbortSignal,
): Promise<string[]> {
  const slug = parseGithubRepo(repo.url);
  if (!slug) return [];
  const api =
    `https://api.github.com/repos/${slug.owner}/${slug.repo}/git/trees/` +
    `${encodeURIComponent(repo.branch)}?recursive=1`;
  const res = await fetch(api, {
    signal,
    headers: { "User-Agent": "loom-skills", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(
      `tree-walk ${slug.owner}/${slug.repo}@${repo.branch} failed: HTTP ${res.status}`,
    );
  }
  const json = (await res.json()) as {
    tree?: Array<{ path?: string; type?: string }>;
    truncated?: boolean;
  };
  if (json.truncated) {
    // GitHub caps recursive trees (~100k entries / 7MB) and returns a partial
    // list. Persisting it would drop SKILL.md paths, and a dropped surface-tagged
    // skill flips selectSkills into tag-or-all. Throw (like a failed file fetch)
    // so refreshCatalog keeps the last-known-good catalog rather than a partial.
    throw new Error(
      `tree-walk ${slug.owner}/${slug.repo}@${repo.branch} was truncated; refusing a partial catalog`,
    );
  }
  const tree = Array.isArray(json.tree) ? json.tree : [];
  return tree
    .filter(
      (n) =>
        n.type === "blob" &&
        typeof n.path === "string" &&
        (n.path === "SKILL.md" || n.path.endsWith("/SKILL.md")),
    )
    .map((n) => n.path as string)
    .sort((a, b) => a.localeCompare(b));
}

/** Walk a repo, fetch+parse each SKILL.md, and return sorted skill entries. */
export async function discoverCatalog(
  repo: ConfiguredSkillRepo,
  signal?: AbortSignal,
  force = false,
): Promise<SkillEntry[]> {
  const paths = await treeWalkSkillPaths(repo, signal);
  // Fetch all SKILL.md files concurrently -- they're independent URLs.
  const results = await Promise.all(paths.map((p) => fetchSkillFile(repo, p, signal, force)));
  const entries: SkillEntry[] = [];
  for (let i = 0; i < paths.length; i++) {
    const res = results[i];
    if (!res.ok) {
      // All-or-nothing: a partial catalog is dangerous. If the files that failed
      // are the surface-tagged ones, selectSkills sees zero tags and falls back
      // to tag-or-all -- surfacing skills that should be hidden. Throw so the
      // caller (refreshCatalog) keeps the last-known-good catalog instead.
      throw new Error(`fetch failed for ${paths[i]}: ${res.error ?? `HTTP ${res.status}`}`);
    }
    const fm = parseFrontmatter(res.text);
    entries.push({
      path: paths[i],
      name: fm.name ?? paths[i],
      description: fm.description ?? "",
      when_to_use: fm.when_to_use,
      surfaces: fm.surfaces ?? [],
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export interface SkillCatalog {
  generatedAt: number;
  skills: SkillEntry[];
}

function catalogCachePath(repo: ConfiguredSkillRepo): string {
  return path.join(skillsCacheDir(repo), "_catalog.json");
}

export function readCatalog(repo: ConfiguredSkillRepo): SkillCatalog | null {
  try {
    const data = JSON.parse(fs.readFileSync(catalogCachePath(repo), "utf-8"));
    if (!data || typeof data.generatedAt !== "number" || !Array.isArray(data.skills)) return null;
    return data as SkillCatalog;
  } catch {
    return null;
  }
}

export function writeCatalog(repo: ConfiguredSkillRepo, skills: SkillEntry[]): void {
  try {
    fs.mkdirSync(skillsCacheDir(repo), { recursive: true });
    const payload: SkillCatalog = { generatedAt: Date.now(), skills };
    fs.writeFileSync(catalogCachePath(repo), JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.error("[skills] catalog write failed:", err);
  }
}

export function isCatalogStale(cat: SkillCatalog, ttlMs: number = CATALOG_TTL_MS): boolean {
  return Date.now() - cat.generatedAt >= ttlMs;
}

/** Re-walk a repo and rewrite its catalog. Skips the walk if the cache is fresh, unless forced. */
export async function refreshCatalog(
  repo: ConfiguredSkillRepo,
  opts?: { force?: boolean; signal?: AbortSignal },
): Promise<SkillEntry[]> {
  const existing = readCatalog(repo);
  if (!opts?.force && existing && !isCatalogStale(existing)) return existing.skills;
  const skills = await discoverCatalog(repo, opts?.signal, opts?.force);
  writeCatalog(repo, skills);
  return skills;
}

export interface CatalogRefreshResult {
  repo: string;
  count: number;
  ok: boolean;
  error?: string;
  cached?: boolean;
  /** Ships in the package; there was nothing to fetch. */
  bundled?: boolean;
}

/** Force-refresh every enabled repo (the manual path). Per-repo errors are reported, not thrown. */
export async function refreshAllCatalogs(): Promise<CatalogRefreshResult[]> {
  // Repos are independent (separate trees + cache dirs) -- refresh concurrently.
  // Per-repo try/catch so one failure doesn't sink the rest. A bundled repo has
  // nothing to refresh: walking it would report a count the router does not use,
  // and offline it would report a failure for a repo that works.
  return Promise.all(
    listEnabledSkillRepos().map(async (repo): Promise<CatalogRefreshResult> => {
      if (readsFromPackage(repo)) {
        const entries = readBundledCatalog()?.[repo.name];
        return { repo: repo.name, count: entries?.length ?? 0, ok: true, bundled: true };
      }
      try {
        const skills = await refreshCatalog(repo, { force: true });
        return { repo: repo.name, count: skills.length, ok: true };
      } catch (e) {
        return {
          repo: repo.name,
          count: 0,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
}

/**
 * Whether this repo is answered from the package. Config alone is not enough:
 * `isBundledRepo` reads the config, and if the vendored tree is missing -- a
 * packaging regression, a half-finished install -- treating the repo as bundled
 * means an empty router, a background refresh that is skipped, and a manual
 * refresh that reports success without fetching. A session that quietly has no
 * skills and says it is fine. Treat it as live instead and let it recover.
 */
function readsFromPackage(repo: ConfiguredSkillRepo): boolean {
  return isBundledRepo(repo) && hasBundledContent(repo.name);
}

/**
 * The entries a repo contributes to the router: what shipped in the package if
 * the repo is still pointed at it, otherwise whatever the last walk cached.
 * There is no hand-written third copy any more -- it had drifted from upstream
 * in both directions, listing a skill under a name it no longer had and missing
 * one that had been tagged for months.
 *
 * The last resort is the shipped catalog for a repo we ship that has been
 * pointed somewhere else. Its descriptions are from the pinned commit rather
 * than from that branch, which is a smaller lie than the alternative: deleting
 * the hand-written fallback left a branch-pointed repo with no skills section
 * at all until a background refresh landed, and that refresh only helps the
 * next session.
 */
export function resolveCatalogEntries(repo: ConfiguredSkillRepo): SkillEntry[] {
  const bundled = readBundledCatalog()?.[repo.name];
  if (readsFromPackage(repo) && bundled?.length) return bundled;
  const cached = readCatalog(repo)?.skills;
  if (cached?.length) return cached;
  return bundled ?? [];
}

/** Current catalog counts without refreshing (the status path). */
export function catalogSummary(): CatalogRefreshResult[] {
  return listEnabledSkillRepos().map((repo) => {
    if (readsFromPackage(repo)) {
      const entries = readBundledCatalog()?.[repo.name];
      return { repo: repo.name, count: entries?.length ?? 0, ok: true, bundled: true };
    }
    const cat = readCatalog(repo);
    return { repo: repo.name, count: cat?.skills.length ?? 0, ok: true, cached: cat !== null };
  });
}

/**
 * For each live repo: refresh on start if stale/missing. Errors are swallowed
 * (keep cache). Bundled repos are skipped -- there is nothing to fetch, and a
 * catalog that rewrites itself mid-session would bust the cached system prompt.
 */
export async function backgroundRefreshSkills(): Promise<void> {
  await Promise.all(
    listEnabledSkillRepos()
      .filter((repo) => !readsFromPackage(repo))
      .map(async (repo) => {
        try {
          await refreshCatalog(repo);
        } catch (err) {
          console.warn(`[skills] background refresh failed for ${repo.name}:`, err);
        }
      }),
  );
}
