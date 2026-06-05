import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { listEnabledSkillRepos, type ConfiguredSkillRepo } from "./skills";
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

/** Resolve a github.com repo URL into its raw.githubusercontent.com base, or null. */
export function githubRawBase(repoUrl: string, branch: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const segs = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segs.length < 2) return null;
  const [owner, repo] = segs;
  if (!owner || !repo) return null;
  const cleanRepo = repo.replace(/\.git$/i, "");
  const cleanBranch = (branch || "main").replace(/^\/+|\/+$/g, "");
  return `https://raw.githubusercontent.com/${owner}/${cleanRepo}/${cleanBranch}`;
}

/** The on-disk cache dir for a repo: ~/.loom/cache/skills/<name>@<hash>/ */
export function skillsCacheDir(repo: ConfiguredSkillRepo): string {
  const tag = createSkillsCacheTag(repo.url, repo.branch);
  return path.join(os.homedir(), ".loom", "cache", "skills", `${repo.name}@${tag}`);
}

export type FetchSkillResult =
  | { ok: true; text: string; cached: boolean }
  | { ok: false; status?: number; error: string };

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

  let response: Response;
  try {
    response = await fetch(`${rawBase}/${cleanPath}`, { signal });
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

function githubOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
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

/** List every SKILL.md path in a repo via the GitHub trees API. Throws on HTTP failure. */
export async function treeWalkSkillPaths(
  repo: ConfiguredSkillRepo,
  signal?: AbortSignal,
): Promise<string[]> {
  const slug = githubOwnerRepo(repo.url);
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
  const json = (await res.json()) as { tree?: Array<{ path?: string; type?: string }> };
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
  const entries: SkillEntry[] = [];
  for (const p of paths) {
    const res = await fetchSkillFile(repo, p, signal, force);
    if (!res.ok) continue; // skip files we can't fetch; keep the rest
    const fm = parseFrontmatter(res.text);
    entries.push({
      path: p,
      name: fm.name ?? p,
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
}

/** Force-refresh every enabled repo (the manual path). Per-repo errors are reported, not thrown. */
export async function refreshAllCatalogs(): Promise<CatalogRefreshResult[]> {
  const out: CatalogRefreshResult[] = [];
  for (const repo of listEnabledSkillRepos()) {
    try {
      const skills = await refreshCatalog(repo, { force: true });
      out.push({ repo: repo.name, count: skills.length, ok: true });
    } catch (e) {
      out.push({
        repo: repo.name,
        count: 0,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/** Current cached catalog counts without refreshing (the status path). */
export function catalogSummary(): CatalogRefreshResult[] {
  return listEnabledSkillRepos().map((repo) => {
    const cat = readCatalog(repo);
    return { repo: repo.name, count: cat?.skills.length ?? 0, ok: true, cached: cat !== null };
  });
}

/** For each enabled repo: refresh on start if stale/missing. Errors are swallowed (keep cache). */
export async function backgroundRefreshSkills(): Promise<void> {
  for (const repo of listEnabledSkillRepos()) {
    try {
      await refreshCatalog(repo);
    } catch (err) {
      console.warn(`[skills] background refresh failed for ${repo.name}:`, err);
    }
  }
}

const MCP_REFERENCE_WHEN_TO_USE =
  "Reach for this before any Galaxy MCP tool call -- creating/listing histories, " +
  "uploading data, finding and running tools, inspecting datasets or invocations -- " +
  "and for the common gotchas (id vs name, history vs dataset ids, collection shapes).";

/**
 * Offline / first-run fallback. Used only when a repo has no resolved-catalog
 * cache yet and the tree-walk can't run. Mirrors whatever is tagged on
 * galaxy-skills `main` at ship time (the curated duo; add workflow-reports when
 * its branch merges). Keep these in sync with the upstream frontmatter.
 */
export const BUILTIN_CATALOG: Record<string, SkillEntry[]> = {
  "galaxy-skills": [
    {
      path: "collection-manipulation/SKILL.md",
      name: "galaxy-transform-collection",
      description:
        "Galaxy Collection Transformation Command - transform Galaxy dataset collections " +
        "reproducibly using Galaxy's native tools. Use when asked to filter, sort, relabel, " +
        "restructure, flatten, nest, merge, or otherwise manipulate Galaxy collections.",
      surfaces: ["loom"],
    },
    {
      path: "galaxy-integration/mcp-reference/SKILL.md",
      name: "galaxy-mcp-reference",
      description:
        "Galaxy MCP server tools reference for histories, datasets, tools, and workflows",
      when_to_use: MCP_REFERENCE_WHEN_TO_USE,
      surfaces: ["loom"],
    },
  ],
};
