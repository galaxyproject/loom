import { describe, it, expect } from "vitest";
import { filterToolsForRole, FilterError } from "../extensions/loom/teams/tool-filter";
import type { RoleSpec } from "../extensions/loom/teams/types";

type FakeTool = { name: string };

const registry = new Map<string, FakeTool>([
  ["read_file",               { name: "read_file" }],
  ["grep",                    { name: "grep" }],
  ["bash",                    { name: "bash" }],
  ["analysis_plan_summary",   { name: "analysis_plan_summary" }],
  ["analysis_plan_create",    { name: "analysis_plan_create" }],
]);

const isReadOnly = (name: string) =>
  new Set(["read_file", "grep", "analysis_plan_summary"]).has(name);

describe("filterToolsForRole", () => {
  it("includes read-only tools from tools_read", () => {
    const role: RoleSpec = {
      name: "Finder",
      system_prompt: "x",
      tools_read: ["read_file", "grep"],
    };
    const out = filterToolsForRole(role, registry, isReadOnly);
    expect(out.map((t) => t.name).sort()).toEqual(["grep", "read_file"]);
  });

  it("rejects tools_read entries that are not read-only", () => {
    const role: RoleSpec = {
      name: "Finder",
      system_prompt: "x",
      tools_read: ["bash"],
    };
    expect(() => filterToolsForRole(role, registry, isReadOnly))
      .toThrow(FilterError);
  });

  it("rejects unknown tool names", () => {
    const role: RoleSpec = {
      name: "Finder",
      system_prompt: "x",
      tools_read: ["nope"],
    };
    expect(() => filterToolsForRole(role, registry, isReadOnly))
      .toThrow(/nope/);
  });

  it("includes tools_write without readonly constraint", () => {
    const role: RoleSpec = {
      name: "Recorder",
      system_prompt: "x",
      tools_read: [],
      tools_write: ["analysis_plan_create"],
    };
    const out = filterToolsForRole(role, registry, isReadOnly);
    expect(out.map((t) => t.name)).toEqual(["analysis_plan_create"]);
  });

  it("de-duplicates when a tool appears in both lists", () => {
    const role: RoleSpec = {
      name: "Mixed",
      system_prompt: "x",
      tools_read: ["read_file"],
      tools_write: ["read_file"],
    };
    const out = filterToolsForRole(role, registry, isReadOnly);
    expect(out.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("returns empty list when role has no declared tools", () => {
    const role: RoleSpec = {
      name: "Pure",
      system_prompt: "x",
      tools_read: [],
    };
    expect(filterToolsForRole(role, registry, isReadOnly)).toEqual([]);
  });
});
