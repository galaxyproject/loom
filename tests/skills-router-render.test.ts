import { describe, it, expect } from "vitest";
import { renderSkillsSection } from "../extensions/loom/context";
import type { SkillEntry } from "../extensions/loom/skills-discovery";

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
});
