import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script with no declarations
import { analyze, EXPECTED_PREFIXES, isSettled, toolGroup } from "../scripts/measure-context.mjs";

describe("measure-context buckets", () => {
  it.each([
    ["mcp__brc_analytics__search_assemblies", "mcp__brc_analytics__*"],
    ["list_mcp_resources", "mcp gateway"],
    ["read_mcp_resource", "mcp gateway"],
    ["mcp_read_output", "mcp gateway"],
    ["galaxy_read_output", "galaxy-ops"],
    ["run_tool", "galaxy-ops"],
    ["galaxy_upload_local_file", "galaxy (loom)"],
    ["bash", "pi builtins"],
  ])("%s goes to %s", (name, group) => {
    expect(toolGroup(name)).toBe(group);
  });

  it("analyze counts each bucket", () => {
    const r = analyze({
      system: "hi",
      tools: [{ name: "run_tool" }, { name: "mcp__brc_analytics__x" }],
    });
    expect(Object.keys(r.groups).sort()).toEqual(["galaxy-ops", "mcp__brc_analytics__*"]);
  });
});

describe("a settled request", () => {
  it("needs brc-analytics' tools, and nothing from Galaxy, which is in-process", () => {
    const greeting = { tools: [{ name: "bash" }, { name: "run_tool" }] };
    expect(isSettled(greeting, EXPECTED_PREFIXES)).toBe(false);
    expect(
      isSettled(
        { tools: [...greeting.tools, { name: "mcp__brc_analytics__x" }] },
        EXPECTED_PREFIXES,
      ),
    ).toBe(true);
  });
});
