import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  parseFrontmatter,
  selectSkills,
  type SkillEntry,
  fetchSkillFile,
  githubRawBase,
  treeWalkSkillPaths,
  discoverCatalog,
  type ConfiguredSkillRepo,
  readCatalog,
  writeCatalog,
  isCatalogStale,
  refreshCatalog,
  skillsCacheDir,
  BUILTIN_CATALOG,
  refreshAllCatalogs,
} from "../extensions/loom/skills-discovery";

describe("parseFrontmatter", () => {
  it("reads name, description, when_to_use, and a surfaces list", () => {
    const text = `---
name: galaxy-mcp-reference
description: Galaxy MCP reference
when_to_use: Use for MCP calls
surfaces: [loom, claude-code]
user_invocable: true
---
body here`;
    const fm = parseFrontmatter(text);
    expect(fm.name).toBe("galaxy-mcp-reference");
    expect(fm.description).toBe("Galaxy MCP reference");
    expect(fm.when_to_use).toBe("Use for MCP calls");
    expect(fm.surfaces).toEqual(["loom", "claude-code"]);
  });

  it("normalizes a scalar surfaces value to a one-element array", () => {
    const fm = parseFrontmatter(`---\nname: x\nsurfaces: loom\n---\n`);
    expect(fm.surfaces).toEqual(["loom"]);
  });

  it("returns empty surfaces when the tag is absent", () => {
    const fm = parseFrontmatter(`---\nname: x\ndescription: y\n---\n`);
    expect(fm.surfaces).toEqual([]);
    expect(fm.when_to_use).toBeUndefined();
  });

  it("returns {} for content with no frontmatter block", () => {
    expect(parseFrontmatter("no frontmatter here")).toEqual({});
  });

  it("returns {} for malformed YAML instead of throwing", () => {
    expect(parseFrontmatter(`---\n: : :\nname: [unclosed\n---\n`)).toEqual({});
  });
});

describe("selectSkills (tag-or-all)", () => {
  const mk = (path: string, surfaces: string[]): SkillEntry => ({
    path,
    name: path,
    description: "",
    surfaces,
  });

  it("returns only loom-tagged skills when at least one is tagged", () => {
    const entries = [mk("a", ["loom"]), mk("b", []), mk("c", ["claude-code"])];
    expect(selectSkills(entries).map((e) => e.path)).toEqual(["a"]);
  });

  it("returns all skills when none are tagged", () => {
    const entries = [mk("a", []), mk("b", [])];
    expect(selectSkills(entries).map((e) => e.path)).toEqual(["a", "b"]);
  });
});

const REPO: ConfiguredSkillRepo = {
  name: "galaxy-skills",
  url: "https://github.com/galaxyproject/galaxy-skills",
  branch: "main",
};

describe("githubRawBase", () => {
  it("maps a github repo url to its raw base", () => {
    expect(githubRawBase(REPO.url, "main")).toBe(
      "https://raw.githubusercontent.com/galaxyproject/galaxy-skills/main",
    );
  });
  it("returns null for non-github urls", () => {
    expect(githubRawBase("https://example.com/x/y", "main")).toBeNull();
  });
});

describe("fetchSkillFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skills-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fetches, writes to cache, and reports cached:false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("hello skill", { status: 200 })));
    const res = await fetchSkillFile(REPO, "collection-manipulation/SKILL.md");
    expect(res).toEqual({ ok: true, text: "hello skill", cached: false });
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    const res2 = await fetchSkillFile(REPO, "collection-manipulation/SKILL.md");
    expect(res2).toEqual({ ok: true, text: "hello skill", cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with the status on a non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));
    const res = await fetchSkillFile(REPO, "missing/SKILL.md");
    expect(res).toEqual({ ok: false, status: 404, error: "HTTP 404" });
  });

  it("expires a SKILL.md cache entry after the 1h catalog TTL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("v1", { status: 200 })));
    await fetchSkillFile(REPO, "x/SKILL.md");
    const cacheFile = fs
      .readdirSync(path.join(tmp, ".loom", "cache", "skills"))
      .map((d) => path.join(tmp, ".loom", "cache", "skills", d, "x", "SKILL.md"))
      .find((p) => fs.existsSync(p))!;
    const old = Date.now() / 1000 - 2 * 60 * 60;
    fs.utimesSync(cacheFile, old, old);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("v2", { status: 200 }),
    );
    const res = await fetchSkillFile(REPO, "x/SKILL.md");
    expect(res).toEqual({ ok: true, text: "v2", cached: false });
  });
});

function mockGithub(tree: Array<{ path: string; type: string }>, files: Record<string, string>) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    const m = /\/main\/(.+)$/.exec(url);
    const key = m?.[1] ?? "";
    if (key in files) return new Response(files[key], { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

describe("treeWalkSkillPaths", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns only SKILL.md blob paths, sorted", async () => {
    vi.stubGlobal(
      "fetch",
      mockGithub(
        [
          { path: "collection-manipulation/SKILL.md", type: "blob" },
          { path: "collection-manipulation/references/tools.md", type: "blob" },
          { path: "galaxy-integration", type: "tree" },
          { path: "galaxy-integration/mcp-reference/SKILL.md", type: "blob" },
        ],
        {},
      ),
    );
    const paths = await treeWalkSkillPaths(REPO);
    expect(paths).toEqual([
      "collection-manipulation/SKILL.md",
      "galaxy-integration/mcp-reference/SKILL.md",
    ]);
  });

  it("throws on a non-200 from the tree API (so callers keep last-known-good)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 403 })),
    );
    await expect(treeWalkSkillPaths(REPO)).rejects.toThrow(/403/);
  });
});

describe("discoverCatalog", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-disc-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("walks, fetches, and parses each SKILL.md into entries", async () => {
    vi.stubGlobal(
      "fetch",
      mockGithub(
        [
          { path: "collection-manipulation/SKILL.md", type: "blob" },
          { path: "galaxy-integration/mcp-reference/SKILL.md", type: "blob" },
        ],
        {
          "collection-manipulation/SKILL.md":
            "---\nname: galaxy-transform-collection\ndescription: transform collections\nsurfaces: [loom]\n---\nbody",
          "galaxy-integration/mcp-reference/SKILL.md":
            "---\nname: galaxy-mcp-reference\ndescription: mcp ref\n---\nbody",
        },
      ),
    );
    const entries = await discoverCatalog(REPO);
    expect(entries).toEqual([
      {
        path: "collection-manipulation/SKILL.md",
        name: "galaxy-transform-collection",
        description: "transform collections",
        when_to_use: undefined,
        surfaces: ["loom"],
      },
      {
        path: "galaxy-integration/mcp-reference/SKILL.md",
        name: "galaxy-mcp-reference",
        description: "mcp ref",
        when_to_use: undefined,
        surfaces: [],
      },
    ]);
  });
});

describe("catalog cache", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cat-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips a written catalog", () => {
    const entries = [{ path: "a/SKILL.md", name: "a", description: "d", surfaces: ["loom"] }];
    writeCatalog(REPO, entries);
    const cat = readCatalog(REPO);
    expect(cat?.skills).toEqual(entries);
    expect(typeof cat?.generatedAt).toBe("number");
  });

  it("returns null for a missing, corrupt, or wrong-shape catalog", () => {
    expect(readCatalog(REPO)).toBeNull(); // missing
    const catFile = path.join(skillsCacheDir(REPO), "_catalog.json");
    fs.mkdirSync(path.dirname(catFile), { recursive: true });
    fs.writeFileSync(catFile, '{"broken":'); // truncated JSON
    expect(readCatalog(REPO)).toBeNull();
    fs.writeFileSync(catFile, JSON.stringify({ generatedAt: "nope", skills: "no" })); // wrong shape
    expect(readCatalog(REPO)).toBeNull();
  });

  it("flags a catalog older than the TTL as stale", () => {
    expect(isCatalogStale({ generatedAt: Date.now(), skills: [] })).toBe(false);
    expect(isCatalogStale({ generatedAt: Date.now() - 2 * 60 * 60 * 1000, skills: [] })).toBe(true);
  });

  it("refreshCatalog skips the walk when the cache is fresh (no fetch)", async () => {
    writeCatalog(REPO, [{ path: "x/SKILL.md", name: "x", description: "", surfaces: [] }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const skills = await refreshCatalog(REPO);
    expect(skills.map((s) => s.path)).toEqual(["x/SKILL.md"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshCatalog with force re-walks and rewrites the cache", async () => {
    writeCatalog(REPO, [{ path: "old/SKILL.md", name: "old", description: "", surfaces: [] }]);
    vi.stubGlobal(
      "fetch",
      mockGithub([{ path: "new/SKILL.md", type: "blob" }], {
        "new/SKILL.md": "---\nname: new\ndescription: fresh\nsurfaces: [loom]\n---\n",
      }),
    );
    const skills = await refreshCatalog(REPO, { force: true });
    expect(skills.map((s) => s.path)).toEqual(["new/SKILL.md"]);
    expect(readCatalog(REPO)?.skills.map((s) => s.path)).toEqual(["new/SKILL.md"]);
  });

  it("refreshCatalog re-walks when the cached catalog is stale", async () => {
    const catFile = path.join(skillsCacheDir(REPO), "_catalog.json");
    fs.mkdirSync(path.dirname(catFile), { recursive: true });
    fs.writeFileSync(
      catFile,
      JSON.stringify({
        generatedAt: Date.now() - 2 * 60 * 60 * 1000, // 2h old, past the 1h TTL
        skills: [{ path: "old/SKILL.md", name: "old", description: "", surfaces: [] }],
      }),
    );
    const fetchMock = mockGithub([{ path: "new/SKILL.md", type: "blob" }], {
      "new/SKILL.md": "---\nname: new\ndescription: fresh\nsurfaces: [loom]\n---\n",
    });
    vi.stubGlobal("fetch", fetchMock);
    const skills = await refreshCatalog(REPO); // no force -- staleness should trigger the walk
    expect(skills.map((s) => s.path)).toEqual(["new/SKILL.md"]);
    expect(fetchMock).toHaveBeenCalled();
    expect(readCatalog(REPO)?.skills.map((s) => s.path)).toEqual(["new/SKILL.md"]);
  });
});

describe("BUILTIN_CATALOG", () => {
  it("ships the curated galaxy-skills duo, all loom-tagged", () => {
    const entries = BUILTIN_CATALOG["galaxy-skills"];
    expect(entries.map((e) => e.path)).toEqual([
      "collection-manipulation/SKILL.md",
      "galaxy-integration/mcp-reference/SKILL.md",
    ]);
    for (const e of entries) expect(e.surfaces).toContain("loom");
  });
});

describe("refreshAllCatalogs", () => {
  let tmp: string;
  beforeEach(() => {
    // Point HOME at a temp dir and write a real ~/.loom/config.json so
    // listEnabledSkillRepos() resolves the repo through its normal path
    // (no module mocking, and no touching the developer's real config).
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-all-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".loom", "config.json"),
      JSON.stringify({
        skills: {
          repos: [{ name: "galaxy-skills", url: REPO.url, branch: "main", enabled: true }],
        },
      }),
      "utf-8",
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("force-refreshes every enabled repo and reports counts", async () => {
    vi.stubGlobal(
      "fetch",
      mockGithub([{ path: "a/SKILL.md", type: "blob" }], {
        "a/SKILL.md": "---\nname: a\ndescription: d\nsurfaces: [loom]\n---\n",
      }),
    );
    const summary = await refreshAllCatalogs();
    expect(summary).toEqual([{ repo: "galaxy-skills", count: 1, ok: true }]);
  });
});
