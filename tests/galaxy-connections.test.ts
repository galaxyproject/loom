import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listGalaxyConnections,
  withGalaxyConnection,
  withGalaxyOrigin,
  verifyGalaxyAccount,
  setGalaxyCredentialEnvelope,
} from "../extensions/loom/galaxy-connections";
import { galaxyGet, getGalaxyConfig, setGalaxyFetchOverride } from "../extensions/loom/galaxy-api";
import {
  upsertJobBlock,
  findJobBlocks,
  locateJobBlock,
  applyJobPollUpdate,
} from "../extensions/loom/galaxy-job-block";
import {
  upsertInvocationBlock,
  findInvocationBlocks,
  locateInvocationBlock,
  applyInvocationUpdates,
} from "../extensions/loom/notebook-writer";
import { galaxyMcpServerName, galaxyMcpToolName } from "../shared/galaxy-mcp-tools.js";

const config = vi.hoisted(() => ({
  galaxy: {
    active: "us",
    profiles: {
      us: { url: "https://us.example", apiKey: "us-key" },
      eu: { url: "https://eu.example", apiKey: "eu-key" },
    },
  },
}));
vi.mock("../extensions/loom/config", () => ({ loadConfig: () => config }));

afterEach(() => {
  setGalaxyFetchOverride(null);
  setGalaxyCredentialEnvelope({});
  vi.unstubAllGlobals();
});

describe("simultaneous Galaxy origins", () => {
  it("isolates concurrent HTTP calls without changing global credentials", async () => {
    const [us, eu] = listGalaxyConnections();
    const observed: unknown[] = [];
    setGalaxyFetchOverride(async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, url.includes("us.example") ? 15 : 1));
      observed.push([url, (init.headers as Record<string, string>)["x-api-key"]]);
      return new Response(JSON.stringify({ url }));
    });
    await Promise.all(
      [us, eu].map((c) => withGalaxyConnection(c, () => galaxyGet("/jobs/same-id"))),
    );
    expect(observed).toEqual([
      ["https://eu.example/api/jobs/same-id", "eu-key"],
      ["https://us.example/api/jobs/same-id", "us-key"],
    ]);
    expect(getGalaxyConfig()?.url).not.toBe("https://eu.example");
  });

  it("keeps identical job IDs from different servers separate", () => {
    const [us, eu] = listGalaxyConnections();
    const job = {
      jobId: "same-id",
      notebookAnchor: "step",
      label: "run",
      submittedAt: "2026-10-18",
      status: "in_progress" as const,
    };
    let text = "# Analysis\n";
    for (const c of [us, eu])
      text = upsertJobBlock(text, { ...job, galaxyServerUrl: c.url }, { connectionId: c.id });
    expect(findJobBlocks(text)).toHaveLength(2);
    expect(
      withGalaxyConnection(eu, () => locateJobBlock(text, "same-id").record?.galaxyServerUrl),
    ).toBe(eu.url);
    text = applyJobPollUpdate(text, {
      jobId: "same-id",
      galaxyServerUrl: eu.url,
      status: "completed",
      lastPolledAt: "2026-10-18T13:00:00Z",
    });
    expect(findJobBlocks(text).map((j) => [j.galaxyServerUrl, j.status])).toEqual([
      [us.url, "in_progress"],
      [eu.url, "completed"],
    ]);
  });

  it("keeps identical workflow invocation IDs separate", () => {
    const [us, eu] = listGalaxyConnections();
    const inv = {
      invocationId: "same-id",
      notebookAnchor: "step",
      label: "run",
      submittedAt: "2026-10-18",
      status: "in_progress" as const,
    };
    let text = "# Analysis\n";
    for (const c of [us, eu])
      text = upsertInvocationBlock(
        text,
        { ...inv, galaxyServerUrl: c.url },
        { connectionId: c.id },
      );
    expect(findInvocationBlocks(text)).toHaveLength(2);
    expect(
      withGalaxyConnection(us, () => locateInvocationBlock(text, "same-id").record?.connectionId),
    ).toBe(us.id);
    text = applyInvocationUpdates(text, [
      {
        invocationId: "same-id",
        galaxyServerUrl: eu.url,
        totalSteps: 1,
        completedSteps: 1,
        totalJobs: 1,
        completedJobs: 1,
        failedJobs: 0,
        lastPolledAt: "2026-10-18T13:00:00Z",
        transition: { status: "completed", summary: "done" },
      },
    ]).content;
    expect(findInvocationBlocks(text).map((j) => [j.galaxyServerUrl, j.status])).toEqual([
      [us.url, "in_progress"],
      [eu.url, "completed"],
    ]);
  });

  it("refuses an origin whose account changed", async () => {
    const eu = listGalaxyConnections()[1];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ id: "new-account", username: "someone-else" })),
      ),
    );
    await expect(
      withGalaxyOrigin(
        { galaxyServerUrl: eu.url, connectionId: eu.id, accountId: "original-account" },
        async () => "wrong",
      ),
    ).rejects.toThrow("another account");
    expect((await verifyGalaxyAccount(eu)).accountId).toBe("new-account");
  });

  it("does not reroute an unknown or removed origin to the default", async () => {
    await expect(
      withGalaxyOrigin({ galaxyServerUrl: "https://removed.example" }, async () => "wrong"),
    ).rejects.toThrow("unavailable");
  });

  it("recognizes isolated MCP namespaces without accepting lookalikes", () => {
    const eu = listGalaxyConnections()[1];
    expect(galaxyMcpToolName(`mcp__${eu.mcpServer}__run_tool`)).toBe("run_tool");
    expect(galaxyMcpServerName(`mcp__${eu.mcpServer}__run_tool`)).toBe(eu.mcpServer);
    expect(galaxyMcpToolName("mcp__galaxy_other__run_tool")).toBeUndefined();
  });
});

describe("Galaxy MCP event context", () => {
  it("routes alternate namespaces through existing guards and capture with the right account", async () => {
    const { scopeGalaxyExtension } = await import("../extensions/loom/galaxy-scope");
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
    const pi = scopeGalaxyExtension({
      on: (name: string, handler: (event: Record<string, unknown>) => unknown) =>
        handlers.set(name, handler),
    } as never);
    const { currentGalaxyConnection } = await import("../extensions/loom/galaxy-connections");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url, init) =>
          new Response(
            JSON.stringify({
              id: (init.headers as Record<string, string>)["x-api-key"] + "-account",
            }),
          ),
      ),
    );
    const seen: unknown[] = [];
    pi.on("tool_result", async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push([
        event.toolName,
        currentGalaxyConnection()?.name,
        currentGalaxyConnection()?.accountId,
      ]);
    });
    const [us, eu] = listGalaxyConnections();
    await Promise.all(
      [us, eu].map((c) =>
        handlers.get("tool_result")!({ toolName: `mcp__${c.mcpServer}__run_tool`, content: [] }),
      ),
    );
    expect(seen).toEqual([
      ["mcp__galaxy__run_tool", "us", "us-key-account"],
      ["mcp__galaxy__run_tool", "eu", "eu-key-account"],
    ]);
    pi.on("tool_call", async () => undefined);
    expect(
      await handlers.get("tool_call")!({
        toolName: `mcp__${eu.mcpServer}__connect`,
        input: { url: us.url },
      }),
    ).toMatchObject({ block: true });
  });
});

describe("multiple accounts on the same Galaxy server", () => {
  it("does not merge identical resource IDs across accounts", () => {
    const old = config.galaxy.profiles.eu.url;
    config.galaxy.profiles.eu.url = config.galaxy.profiles.us.url;
    try {
      const [us, eu] = listGalaxyConnections();
      const base = {
        jobId: "same-id",
        galaxyServerUrl: us.url,
        notebookAnchor: "step",
        label: "run",
        submittedAt: "2026-10-18",
        status: "in_progress" as const,
      };
      let notebook = upsertJobBlock("", base, { connectionId: us.id, accountId: "user-us" });
      notebook = upsertJobBlock(notebook, base, { connectionId: eu.id, accountId: "user-eu" });
      expect(findJobBlocks(notebook)).toHaveLength(2);
      notebook = applyJobPollUpdate(notebook, {
        jobId: "same-id",
        galaxyServerUrl: eu.url,
        connectionId: eu.id,
        accountId: "user-eu",
        status: "completed",
        lastPolledAt: "2026-10-18",
      });
      expect(findJobBlocks(notebook).map((b) => b.status)).toEqual(["in_progress", "completed"]);
    } finally {
      config.galaxy.profiles.eu.url = old;
    }
  });
});
