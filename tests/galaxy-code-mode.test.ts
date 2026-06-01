import { describe, it, expect } from "vitest";
import { resolveGalaxyToolName } from "../extensions/loom/galaxy-code-mode";
import { redactArgs } from "../extensions/loom/activity-hooks";

describe("resolveGalaxyToolName", () => {
  it("passes named-mode tools through unchanged", () => {
    expect(resolveGalaxyToolName("galaxy_create_history", {})).toBe("galaxy_create_history");
    expect(resolveGalaxyToolName("bash", { command: "ls" })).toBe("bash");
    expect(resolveGalaxyToolName(undefined, {})).toBeUndefined();
  });

  it("unwraps the code-mode meta-tool to the dispatched Galaxy tool", () => {
    expect(
      resolveGalaxyToolName("galaxy_run_galaxy_tool", { name: "create_history", args: {} }),
    ).toBe("galaxy_create_history");
    expect(resolveGalaxyToolName("galaxy_run_galaxy_tool", { name: "connect", args: {} })).toBe(
      "galaxy_connect",
    );
  });

  it("falls back to the meta-tool name when args carry no dispatch name", () => {
    expect(resolveGalaxyToolName("galaxy_run_galaxy_tool", {})).toBe("galaxy_run_galaxy_tool");
    expect(resolveGalaxyToolName("galaxy_run_galaxy_tool", undefined)).toBe(
      "galaxy_run_galaxy_tool",
    );
  });
});

describe("redactArgs -- code-mode credential dispatches", () => {
  it("whole-object redacts a code-mode connect even though the tool name is the meta-tool", () => {
    const out = redactArgs("galaxy_run_galaxy_tool", {
      name: "connect",
      args: { url: "https://usegalaxy.org", api_key: "SECRET" },
    });
    expect(out).toEqual({ _redacted: true });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("still whole-object redacts named-mode galaxy_connect", () => {
    expect(redactArgs("galaxy_connect", { api_key: "SECRET" })).toEqual({ _redacted: true });
  });

  it("redacts credential keys nested in a non-credential code-mode call", () => {
    const out = redactArgs("galaxy_run_galaxy_tool", {
      name: "run_tool",
      args: { tool_id: "cat1", api_key: "SECRET" },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("SECRET");
    // non-secret fields survive
    expect(JSON.stringify(out)).toContain("run_tool");
  });
});
