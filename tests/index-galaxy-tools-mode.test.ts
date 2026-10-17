/**
 * What the desktop flag changes at extension load, read off a stand-in pi: with
 * it unset nothing may differ from before it existed; with it set the Galaxy
 * tools are in-process and only galaxy-mcp leaves pi's MCP layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hermetic: the developer's own experiments.galaxyTools must not pick the mode.
vi.mock("../extensions/loom/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/loom/config")>()),
  loadConfig: () => ({}),
}));
vi.mock("../extensions/loom/galaxy-version-capture", async (importOriginal) => {
  const real = await importOriginal<typeof import("../extensions/loom/galaxy-version-capture")>();
  return { ...real, registerGalaxyVersionCapture: vi.fn(real.registerGalaxyVersionCapture) };
});

import { allOperations } from "@galaxyproject/galaxy-ops";
import { installedCapabilityProfile, setCapabilityProfile } from "../shared/capability-profile.js";
import { registerGalaxyVersionCapture } from "../extensions/loom/galaxy-version-capture";
import { galaxyToolFamily, setGalaxyToolSource } from "../extensions/loom/galaxy-tool-source";

interface Loaded {
  tools: string[];
  servers: string[];
  on: Map<string, number>;
}

async function load(env: Record<string, string>): Promise<Loaded> {
  const loaded: Loaded = { tools: [], servers: [], on: new Map() };
  const noop = () => undefined;
  const pi = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "registerTool") return (def: { name: string }) => loaded.tools.push(def.name);
        if (prop === "registerMcpServer") return (name: string) => loaded.servers.push(name);
        if (prop === "on")
          return (event: string) => loaded.on.set(event, (loaded.on.get(event) ?? 0) + 1);
        if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
        if (prop === "events") return { on: noop, emit: noop };
        return noop;
      },
    },
  );
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import("../extensions/loom/index");
  mod.default(pi as never);
  return loaded;
}

const CREDENTIALS = { GALAXY_URL: "https://galaxy.example.org", GALAXY_API_KEY: "fixture-key" };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (/^(ORBIT|LOOM)_(GALAXY_TOOLS|LOCAL_EXEC|LOCAL_SHELL)$/.test(name))
      vi.stubEnv(name, undefined);
  }
  vi.mocked(registerGalaxyVersionCapture).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  setCapabilityProfile(null);
  setGalaxyToolSource(null);
});

describe("the desktop with LOOM_GALAXY_TOOLS unset", () => {
  it("registers galaxy-mcp and brc-analytics and installs no profile", async () => {
    const { servers, tools } = await load(CREDENTIALS);
    expect(servers).toEqual(["galaxy", "brc-analytics"]);
    expect(installedCapabilityProfile()).toBeNull();
    expect(tools).toContain("mcp_read_output");
    expect(tools).not.toContain("galaxy_read_output");
    expect(tools).not.toContain("run_tool");
    expect(registerGalaxyVersionCapture).not.toHaveBeenCalled();
  });

  it("is the same with LOOM_GALAXY_TOOLS=mcp", async () => {
    const unset = await load(CREDENTIALS);
    const mcp = await load({ ...CREDENTIALS, LOOM_GALAXY_TOOLS: "mcp" });
    expect(mcp.servers).toEqual(unset.servers);
    expect(mcp.tools).toEqual(unset.tools);
    expect(mcp.on).toEqual(unset.on);
    expect(installedCapabilityProfile()).toBeNull();
  });
});

describe("the desktop with LOOM_GALAXY_TOOLS=bare", () => {
  it("keeps brc-analytics, drops galaxy-mcp, and registers the in-process tools", async () => {
    const { servers, tools } = await load({ ...CREDENTIALS, LOOM_GALAXY_TOOLS: "bare" });
    expect(servers).toEqual(["brc-analytics"]);
    expect(installedCapabilityProfile()?.galaxyTools).toBe("bare");
    for (const name of [
      ...allOperations.map((op) => op.name),
      "list_jobs",
      "get_job_logs",
      "galaxy_read_output",
    ])
      expect(tools, name).toContain(name);
    expect(tools).not.toContain("mcp_read_output");
    expect(galaxyToolFamily().tool("run_tool")).toBe("run_tool");
    expect(registerGalaxyVersionCapture).toHaveBeenCalledTimes(1);
  });

  it("adds handlers only through the bare registrations", async () => {
    const unset = await load(CREDENTIALS);
    setCapabilityProfile(null);
    setGalaxyToolSource(null);
    const bare = await load({ ...CREDENTIALS, LOOM_GALAXY_TOOLS: "bare" });
    const events = new Set([...unset.on.keys(), ...bare.on.keys()]);
    const delta = Object.fromEntries(
      [...events]
        .map((e) => [e, (bare.on.get(e) ?? 0) - (unset.on.get(e) ?? 0)] as const)
        .filter(([, d]) => d !== 0),
    );
    // The MCP output recovery (session_start, session_tree, tool_result) goes; the destructive
    // confirm (tool_call), the page policy's reset (session_start) and the version capture
    // (session_start, tool_result) come.
    expect(delta).toEqual({ session_start: 1, session_tree: -1, tool_call: 1 });
  });

  it("takes its profile down when a reload finds the flag gone", async () => {
    await load({ ...CREDENTIALS, LOOM_GALAXY_TOOLS: "bare" });
    expect(installedCapabilityProfile()?.galaxyTools).toBe("bare");
    vi.unstubAllEnvs();
    setGalaxyToolSource(null);
    const reloaded = await load(CREDENTIALS);
    expect(installedCapabilityProfile()).toBeNull();
    expect(reloaded.servers).toEqual(["galaxy", "brc-analytics"]);
  });

  it("stays on MCP without a local exec surface", async () => {
    const { servers, tools } = await load({
      ...CREDENTIALS,
      LOOM_GALAXY_TOOLS: "bare",
      LOOM_LOCAL_EXEC: "off",
    });
    expect(servers).toEqual(["galaxy", "brc-analytics"]);
    expect(installedCapabilityProfile()).toBeNull();
    expect(tools).not.toContain("run_tool");
  });
});
