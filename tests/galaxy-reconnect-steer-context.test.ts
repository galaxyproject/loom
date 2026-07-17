import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../extensions/loom/config", () => ({
  loadConfig: () => ({ executionMode: "hybrid" }),
}));

import { buildGalaxyContextBlock } from "../extensions/loom/context";

let prev: Record<string, string | undefined>;

beforeEach(() => {
  prev = { url: process.env.GALAXY_URL, key: process.env.GALAXY_API_KEY };
  process.env.GALAXY_URL = "https://galaxy.test";
  process.env.GALAXY_API_KEY = "k";
});

afterEach(() => {
  process.env.GALAXY_URL = prev.url;
  process.env.GALAXY_API_KEY = prev.key;
});

describe("buildGalaxyContextBlock reconnect steer", () => {
  it("steers the model to call galaxy_connect() before reporting a disconnection", () => {
    const block = buildGalaxyContextBlock();
    // The whole point of Scott's report: never dead-end on "disconnected".
    expect(block).toContain("galaxy_connect()");
    expect(block).toMatch(/never report.*disconnected/i);
  });

  it("names the /mcp reconnect galaxy fallback for a dead transport", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("/mcp reconnect galaxy");
  });

  it("explains the connection does not survive resume/idle", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/does \*\*not\*\* survive a resume/i);
  });

  it("does not add reconnect guidance when Galaxy is not connected", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    const block = buildGalaxyContextBlock();
    expect(block).not.toContain("/mcp reconnect galaxy");
  });
});
