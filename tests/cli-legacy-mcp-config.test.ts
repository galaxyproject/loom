import { describe, it, expect } from "vitest";
import { stripLegacyMcpEntries } from "../bin/legacy-mcp-config.js";

describe("stripLegacyMcpEntries", () => {
  it("drops Loom's servers and the adapter's scriptMode, keeping the user's own", () => {
    const config = {
      mcpServers: {
        galaxy: { command: "uvx", env: { GALAXY_API_KEY: "plaintext" } },
        "brc-analytics": { url: "https://dev.brc-analytics.org/api/v1/mcp/" },
        mine: { command: "my-server" },
      },
      settings: { scriptMode: false },
    };
    expect(stripLegacyMcpEntries(config)).toEqual({
      changed: true,
      empty: false,
      removedGalaxy: true,
      notices: [],
    });
    expect(config).toEqual({ mcpServers: { mine: { command: "my-server" } } });
  });

  it("reports empty when only Loom's entries were there", () => {
    const config = { mcpServers: { galaxy: { command: "uvx" } }, settings: { scriptMode: false } };
    expect(stripLegacyMcpEntries(config)).toMatchObject({ changed: true, empty: true });
  });

  it("leaves a file with nothing of ours alone", () => {
    const config = { mcpServers: { mine: { command: "x" } }, autoEnableCodemode: false };
    expect(stripLegacyMcpEntries(config)).toMatchObject({ changed: false, empty: false });
    expect(config).toEqual({ mcpServers: { mine: { command: "x" } }, autoEnableCodemode: false });
  });

  it("tolerates a file without mcpServers", () => {
    expect(stripLegacyMcpEntries({})).toMatchObject({ changed: false, empty: true });
  });

  it("keeps a galaxy or brc-analytics override written for pi's built-in MCP", () => {
    const config = {
      mcpServers: {
        galaxy: { command: "uvx", args: ["galaxy-mcp==2.0.0"], exposure: "direct" },
        "brc-analytics": { url: "https://staging.example/mcp", enabled: false },
      },
    };
    const before = structuredClone(config);
    expect(stripLegacyMcpEntries(config)).toMatchObject({ changed: false, removedGalaxy: false });
    expect(config).toEqual(before);
  });

  it("keeps other adapter settings", () => {
    const config = { mcpServers: {}, settings: { scriptMode: false, idleTimeout: 10 } };
    stripLegacyMcpEntries(config);
    expect(config.settings).toEqual({ idleTimeout: 10 });
  });

  it("carries tool filtering over to pi's exposure fields", () => {
    const config = {
      mcpServers: {
        fs: { command: "fs-server", excludeTools: ["delete_file"], directTools: true },
        docs: { url: "https://docs.example/mcp", includeTools: ["search", "read"] },
        picks: { command: "p", directTools: ["a"], requestTimeoutMs: 90_500 },
      },
    };
    expect(stripLegacyMcpEntries(config)).toMatchObject({ changed: true, notices: [] });
    expect(config.mcpServers).toEqual({
      fs: { command: "fs-server", exposure: "direct", toolExposure: { delete_file: "hidden" } },
      docs: {
        url: "https://docs.example/mcp",
        exposure: "hidden",
        toolExposure: { search: "codemode", read: "codemode" },
      },
      picks: { command: "p", toolExposure: { a: "direct" }, timeout: 91 },
    });
  });

  it("moves bearer tokens into an Authorization header", () => {
    const config = {
      mcpServers: {
        a: { url: "https://a.example/mcp", bearerTokenEnv: "A_TOKEN" },
        b: { url: "https://b.example/mcp", bearerToken: "literal" },
        c: { url: "https://c.example/mcp", bearerTokenEnv: "C", headers: { authorization: "x" } },
      },
    };
    stripLegacyMcpEntries(config);
    expect(config.mcpServers.a).toEqual({
      url: "https://a.example/mcp",
      headers: { Authorization: "Bearer ${A_TOKEN}" },
    });
    expect(config.mcpServers.b.headers).toEqual({ Authorization: "Bearer literal" });
    expect(config.mcpServers.c.headers).toEqual({ authorization: "x" });
  });

  it("disables a server that relied on adapter-only safeguards", () => {
    const config = {
      mcpServers: {
        risky: { command: "r", approveTools: true },
        ok: { command: "o", approveTools: false },
      },
    };
    const { notices } = stripLegacyMcpEntries(config);
    expect(config.mcpServers.risky).toEqual({ command: "r", enabled: false });
    expect(config.mcpServers.ok).toEqual({ command: "o" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/"risky".*approveTools/);
  });
});
