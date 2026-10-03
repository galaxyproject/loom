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
  it("steers the model to call mcp__galaxy__connect() before reporting a disconnection", () => {
    const block = buildGalaxyContextBlock();
    // The whole point of Scott's report: never dead-end on "disconnected".
    expect(block).toContain("mcp__galaxy__connect()");
    expect(block).toMatch(/never report.*disconnected/i);
  });

  it("has the agent re-bind before pointing the user at /mcp reconnect", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("the connection comes back on the next call");
    expect(block).not.toContain("mcp({connect");
    // The manual command is a fallback, never the first step.
    expect(block.indexOf("/mcp reconnect galaxy")).toBeGreaterThan(
      block.indexOf("mcp__galaxy__connect()"),
    );
  });

  it("distinguishes an idle connection from an unknown timeout outcome", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("timeout alone does not prove");
  });

  it("does not add reconnect guidance when Galaxy is not connected", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    const block = buildGalaxyContextBlock();
    expect(block).not.toContain("/mcp reconnect galaxy");
  });
});
