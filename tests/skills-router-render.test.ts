import { describe, it, expect } from "vitest";
import { renderSkillsSection } from "../extensions/orbit/context";
import type { SkillEntry } from "../extensions/orbit/skills-discovery";

const repos = [
  { name: "galaxy-skills", url: "https://github.com/galaxyproject/galaxy-skills", branch: "main" },
];

describe("renderSkillsSection", () => {
  it("renders one router line per entry with the fetch path", () => {
    const entries: SkillEntry[] = [
      {
        path: "collection-manipulation/SKILL.md",
        name: "galaxy-transform-collection",
        description: "transform collections",
        surfaces: ["loom"],
      },
    ];
    const out = renderSkillsSection(repos, new Map([["galaxy-skills", entries]]));
    expect(out).toContain("galaxy-transform-collection");
    expect(out).toContain('path: "collection-manipulation/SKILL.md"');
    expect(out).toContain("## Skills repositories");
  });

  it("includes when_to_use as a sub-line only when present", () => {
    const entries: SkillEntry[] = [
      {
        path: "galaxy-integration/mcp-reference/SKILL.md",
        name: "galaxy-mcp-reference",
        description: "mcp ref",
        when_to_use: "Use for MCP calls",
        surfaces: ["loom"],
      },
    ];
    const out = renderSkillsSection(repos, new Map([["galaxy-skills", entries]]));
    expect(out).toContain("When to use: Use for MCP calls");
  });

  it("returns empty string when there are no repos", () => {
    expect(renderSkillsSection([], new Map())).toBe("");
  });

  it("omits the repo arg for the first repo and includes it for others", () => {
    const twoRepos = [
      {
        name: "galaxy-skills",
        url: "https://github.com/galaxyproject/galaxy-skills",
        branch: "main",
      },
      { name: "extra", url: "https://github.com/galaxyproject/extra", branch: "main" },
    ];
    const map = new Map<string, SkillEntry[]>([
      ["galaxy-skills", [{ path: "a/SKILL.md", name: "a", description: "d", surfaces: ["loom"] }]],
      ["extra", [{ path: "b/SKILL.md", name: "b", description: "d", surfaces: ["loom"] }]],
    ]);
    const out = renderSkillsSection(twoRepos, map);
    expect(out).toContain('skills_fetch({ path: "a/SKILL.md" })');
    expect(out).toContain('skills_fetch({ repo: "extra", path: "b/SKILL.md" })');
  });

  it("labels a staging repo and names it in every fetch line", () => {
    const withStaging = [...repos, { name: "orbit", url: "", branch: "" }];
    const map = new Map<string, SkillEntry[]>([
      ["galaxy-skills", [{ path: "a/SKILL.md", name: "a", description: "d", surfaces: ["loom"] }]],
      ["orbit", [{ path: "b/SKILL.md", name: "b", description: "d", surfaces: ["loom"] }]],
    ]);
    const out = renderSkillsSection(
      withStaging,
      map,
      new Set(["galaxy-skills"]),
      new Set(["orbit"]),
    );
    expect(out).toContain("- **orbit** — staging in Orbit until it moves to a permanent home");
    expect(out).toContain('skills_fetch({ path: "a/SKILL.md" })');
    expect(out).toContain('skills_fetch({ repo: "orbit", path: "b/SKILL.md" })');
    expect(out).toContain("ships with Orbit and reads from disk");
  });

  it("never makes a staging repo the default, even when nothing is configured", () => {
    // A repo-less skills_fetch goes to the first configured repo, and with none
    // configured it errors -- so the staging repo's lines must still name it.
    const map = new Map<string, SkillEntry[]>([
      ["orbit", [{ path: "b/SKILL.md", name: "b", description: "d", surfaces: ["loom"] }]],
    ]);
    const out = renderSkillsSection(
      [{ name: "orbit", url: "", branch: "" }],
      map,
      new Set(),
      new Set(["orbit"]),
    );
    expect(out).toContain('skills_fetch({ repo: "orbit", path: "b/SKILL.md" })');
  });
});
