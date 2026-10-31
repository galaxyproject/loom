// @vitest-environment node
/**
 * The Orbit worker's boot (slice 3, commit 13): the grant decides what the brain registers, and a
 * grant Orbit can't map stops the worker before it opens anything. Each case loads the modules
 * fresh: the seams bootOrbit installs are process-wide, as they are in a worker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

async function boot(capabilities: string[], withShell = false) {
  vi.resetModules();
  const { bootOrbit } = await import("./boot");
  const { createMemoryLedger } = await import("../../../../../extensions/orbit/submission-ledger");
  const shell = withShell ? await shellPieces(capabilities) : {};
  return bootOrbit({
    capabilities,
    galaxy: { fetch: async () => json({}), url: "http://galaxy.test" },
    ledger: createMemoryLedger(),
    secrets: () => [],
    ui: { ask: async () => undefined, notify: () => {} },
    ...shell,
  });
}

/** The browser's extras and shell tools as orbit/worker.ts builds them, over an inert host. */
async function shellPieces(capabilities: string[]) {
  const { adaptTool, galaxyExtras, granted } = await import("./adapter");
  const { galaxyTools } = await import("../galaxy-extras");
  const { pythonTool } = await import("../python");
  const { processTools } = await import("../processes");
  const host = {
    clients: () => ({}) as never,
    conversation: () => undefined,
    binding: async () => ({}),
    rebind: async () => {},
    artifacts: async () => [],
  };
  const tools = [pythonTool(), ...processTools()].filter((t) => granted(t, capabilities));
  return {
    // Under Node the full galaxy-ops entry loads, which has download_dataset of its own.
    extras: galaxyExtras(galaxyTools(), host),
    shellTools: tools.map((t) => adaptTool(t, host)),
    layers: { brandName: "Olit", shellTools: () => new Set<string>(), artifacts: async () => [] },
  };
}

afterEach(async () => {
  const { setCapabilityProfile } = await import("../../../../../shared/capability-profile.js");
  setCapabilityProfile(null);
  vi.unstubAllGlobals();
});

describe("the Orbit worker's boot", () => {
  it("registers Galaxy's writers and the record's under a write grant", async () => {
    const { host } = await boot(["llm", "local", "read", "write"]);
    expect(host.tools).toEqual(expect.arrayContaining(["run_tool", "galaxy_job_record"]));
  });

  it("declares no writing tool under a read grant", async () => {
    const { host } = await boot(["llm", "read"]);
    const { ORBIT_WRITING_TOOLS } = await import("../../../../../extensions/orbit/galaxy-grant");
    const { registeredGalaxyTools } =
      await import("../../../../../extensions/orbit/galaxy-tool-source");
    for (const tool of registeredGalaxyTools()) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
    for (const name of ORBIT_WRITING_TOOLS) expect(host.tools, name).not.toContain(name);
    expect(host.tools).toContain("galaxy_read_output");
  });

  it("registers the browser's extras and its Python tools by the grant", async () => {
    const full = await boot(["llm", "local", "read", "write"], true);
    expect(full.host.tools).toEqual(
      expect.arrayContaining([
        "download_dataset",
        "recommend_biocontainer",
        "run_python",
        "lineage_report",
        "organize_datasets",
      ]),
    );
    const read = await boot(["llm", "local", "read"], true);
    expect(read.host.tools).toEqual(
      expect.arrayContaining(["recommend_biocontainer", "run_python", "lineage_report"]),
    );
    expect(read.host.tools).not.toContain("organize_datasets");
    const noPython = await boot(["llm", "read", "write"], true);
    expect(noPython.host.tools).not.toContain("run_python");
  });

  it("refuses a second boot in the same worker", async () => {
    await boot(["llm", "read"]);
    const { bootOrbit } = await import("./boot");
    expect(() =>
      bootOrbit({
        capabilities: ["llm", "read"],
        galaxy: { fetch: async () => json({}), url: "http://galaxy.test" },
        ledger: {} as never,
        secrets: () => [],
        ui: { ask: async () => undefined, notify: () => {} },
      }),
    ).toThrow(/already booted/);
  });
});

describe("the Orbit worker's open", () => {
  it("posts failed for a grant Orbit can't map, before it asks Galaxy anything", async () => {
    vi.resetModules();
    const posted: unknown[] = [];
    const fetched: string[] = [];
    const self = {
      postMessage: (message: unknown) => void posted.push(message),
      close: () => {},
      location: { href: "http://galaxy.test/" },
      onmessage: undefined as undefined | ((event: { data: unknown }) => void),
    };
    vi.stubGlobal("self", self);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return json({});
    });
    const { startAgentWorker } = await import("../worker");
    startAgentWorker({});
    self.onmessage!({
      data: {
        type: "open",
        request: {
          pyodideURL: "",
          config: { galaxy_root: "/", capabilities: ["llm", "write"] },
          placement: {},
        },
      },
    });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: "failed", message: expect.stringMatching(/"read"/) });
    expect(fetched).toEqual([]);
  });
});
