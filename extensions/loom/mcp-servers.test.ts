import { describe, it, expect, vi } from "vitest";
import { loomMcpServers, registerLoomMcpServers } from "./mcp-servers";
import { GALAXY_MCP_SPEC } from "../../shared/galaxy-mcp-spec.js";

describe("loomMcpServers", () => {
  it("registers Galaxy only when both credentials are set", () => {
    expect(loomMcpServers({}).galaxy).toBeUndefined();
    expect(loomMcpServers({ GALAXY_URL: "https://usegalaxy.org" }).galaxy).toBeUndefined();
    expect(
      loomMcpServers({ GALAXY_URL: "https://usegalaxy.org", GALAXY_API_KEY: "k" }).galaxy,
    ).toBeDefined();
  });

  it("references the key instead of embedding it", () => {
    const { galaxy } = loomMcpServers({
      GALAXY_URL: "https://usegalaxy.org",
      GALAXY_API_KEY: "secret",
    });
    expect(JSON.stringify(galaxy)).not.toContain("secret");
    expect(galaxy).toMatchObject({
      command: "uvx",
      args: [GALAXY_MCP_SPEC],
      exposure: "direct",
      toolExposure: { upload_file: "hidden" },
      timeout: 300,
      env: { GALAXY_URL: "${GALAXY_URL}", GALAXY_API_KEY: "${GALAXY_API_KEY}" },
    });
  });

  it("always registers BRC Analytics as direct tools", () => {
    expect(loomMcpServers({})["brc-analytics"]).toEqual({
      url: "https://brc-analytics.org/api/v1/mcp/",
      exposure: "direct",
    });
  });
});

describe("loomMcpServers without galaxy", () => {
  const creds = { GALAXY_URL: "https://usegalaxy.org", GALAXY_API_KEY: "k" };

  it("drops galaxy-mcp and keeps BRC Analytics", () => {
    expect(Object.keys(loomMcpServers(creds, { galaxy: false }))).toEqual(["brc-analytics"]);
  });

  it("registers galaxy-mcp by default, as before", () => {
    expect(loomMcpServers(creds, {})).toEqual(loomMcpServers(creds));
    expect(Object.keys(loomMcpServers(creds))).toEqual(["galaxy", "brc-analytics"]);
  });
});

describe("registerLoomMcpServers", () => {
  it("hands every server to pi", () => {
    const registerMcpServer = vi.fn();
    registerLoomMcpServers({ registerMcpServer } as never);
    expect(registerMcpServer.mock.calls.map(([name]) => name)).toContain("brc-analytics");
  });

  it("forwards galaxy: false", () => {
    vi.stubEnv("GALAXY_URL", "https://usegalaxy.org");
    vi.stubEnv("GALAXY_API_KEY", "k");
    try {
      const registerMcpServer = vi.fn();
      registerLoomMcpServers({ registerMcpServer } as never, { galaxy: false });
      expect(registerMcpServer.mock.calls.map(([name]) => name)).toEqual(["brc-analytics"]);
      registerMcpServer.mockClear();
      registerLoomMcpServers({ registerMcpServer } as never);
      expect(registerMcpServer.mock.calls.map(([name]) => name)).toEqual([
        "galaxy",
        "brc-analytics",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
