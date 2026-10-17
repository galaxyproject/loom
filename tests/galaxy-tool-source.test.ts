import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  galaxyToolFamily,
  installedGalaxyToolSource,
  registerGalaxyTools,
  registeredGalaxyTools,
  setGalaxyToolSource,
  type GalaxyTool,
} from "../extensions/loom/galaxy-tool-source";
import { MCP_FAMILY } from "../shared/galaxy-mcp-tools.js";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const stub = (name: string): GalaxyTool => ({
  name,
  label: name,
  description: `stub ${name}`,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
});

function fakePi() {
  const registerTool = vi.fn();
  return { pi: { registerTool } as unknown as ExtensionAPI, registerTool };
}

afterEach(() => {
  setCapabilityProfile(null);
  setGalaxyToolSource(null);
});

describe("galaxy tool source", () => {
  it("with no profile installed the family is MCP, whatever source is installed", () => {
    setGalaxyToolSource({ tools: () => [stub("run_tool")] });
    expect(galaxyToolFamily()).toBe(MCP_FAMILY);
    expect(installedGalaxyToolSource()).not.toBeNull();
  });

  it("under a bare profile registers the source's tools in order and names them as the family", () => {
    setCapabilityProfile({ ...profileFromEnv({}), galaxyTools: "bare" });
    setGalaxyToolSource({ tools: () => [stub("run_tool"), stub("get_dataset_details")] });
    const { pi, registerTool } = fakePi();
    const family = registerGalaxyTools(pi);
    expect(registerTool.mock.calls.map(([t]) => t.name)).toEqual([
      "run_tool",
      "get_dataset_details",
    ]);
    expect(family.toolName("run_tool")).toBe("run_tool");
    expect(family.toolName("get_dataset_details")).toBe("get_dataset_details");
    expect(family.toolName("bash")).toBeUndefined();
    expect(family.tool("run_tool")).toBe("run_tool");
    expect(galaxyToolFamily()).toBe(family);
  });

  it("under a bare profile with no source installed registers the default galaxy-ops source", () => {
    setCapabilityProfile({ ...profileFromEnv({}), galaxyTools: "bare" });
    const { pi, registerTool } = fakePi();
    const family = registerGalaxyTools(pi);
    const names = registerTool.mock.calls.map(([t]) => t.name);
    // The Node entry's 45 operations and Loom's two job bridges, then the saved-output reader
    // outside the family.
    expect(names).toHaveLength(48);
    expect(names.slice(-3)).toEqual(["list_jobs", "get_job_logs", "galaxy_read_output"]);
    expect(family.toolName("run_tool")).toBe("run_tool");
    expect(family.toolName("list_jobs")).toBe("list_jobs");
    expect(family.toolName("get_job_logs")).toBe("get_job_logs");
    expect(family.toolName("galaxy_read_output")).toBeUndefined();
    expect(galaxyToolFamily().toolName("run_tool")).toBe("run_tool");
    expect(registeredGalaxyTools()).toHaveLength(48);
  });

  it("registers a source's companions after its tools, outside the family", () => {
    setCapabilityProfile({ ...profileFromEnv({}), galaxyTools: "bare" });
    setGalaxyToolSource({ tools: () => [stub("run_tool")], companions: () => [stub("reader")] });
    const { pi, registerTool } = fakePi();
    const family = registerGalaxyTools(pi);
    expect(registerTool.mock.calls.map(([t]) => t.name)).toEqual(["run_tool", "reader"]);
    expect(family.toolName("reader")).toBeUndefined();
  });

  it("refuses two tools under one name before registering any", () => {
    setCapabilityProfile({ ...profileFromEnv({}), galaxyTools: "bare" });
    setGalaxyToolSource({ tools: () => [stub("run_tool")], companions: () => [stub("run_tool")] });
    const { pi, registerTool } = fakePi();
    expect(() => registerGalaxyTools(pi)).toThrow("two Galaxy tools are named run_tool");
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("uninstalling the source forgets the registered family", () => {
    setCapabilityProfile({ ...profileFromEnv({}), galaxyTools: "bare" });
    setGalaxyToolSource({ tools: () => [stub("run_tool")] });
    registerGalaxyTools(fakePi().pi);
    expect(galaxyToolFamily().toolName("run_tool")).toBe("run_tool");
    setGalaxyToolSource(null);
    expect(galaxyToolFamily().toolName("run_tool")).toBeUndefined();
    expect(registeredGalaxyTools()).toEqual([]);
  });
});
