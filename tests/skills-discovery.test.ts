import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  selectSkills,
  type SkillEntry,
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
