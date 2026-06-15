import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// buildGalaxyContextBlock reads executionMode from loadConfig(); control it so
// the block is deterministic regardless of the dev machine's ~/.loom/config.json.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import { buildGalaxyContextBlock } from "../extensions/loom/context";

const ENV_KEYS = ["LOOM_LOCAL_SHELL", "GALAXY_URL", "GALAXY_API_KEY"] as const;

describe("buildGalaxyContextBlock under LOOM_LOCAL_SHELL", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({});
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("never claims local execution when there is no local shell and no Galaxy creds", () => {
    process.env.LOOM_LOCAL_SHELL = "off";
    const block = buildGalaxyContextBlock();
    expect(block).toContain("NOT CONNECTED");
    // The remote-only block in the same prompt says there is no local path;
    // this block must not contradict it.
    expect(block).not.toMatch(/execution is local/i);
    expect(block).toContain("/connect");
  });

  it("keeps the local-fallback wording when a local shell exists and no Galaxy creds", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("NOT CONNECTED");
    expect(block).toMatch(/All execution is local/);
  });

  it("emits the connected block regardless of shell availability", () => {
    process.env.LOOM_LOCAL_SHELL = "off";
    process.env.GALAXY_URL = "https://galaxy.example";
    process.env.GALAXY_API_KEY = "test-key";
    const block = buildGalaxyContextBlock();
    expect(block).toContain("https://galaxy.example");
    expect(block).not.toContain("NOT CONNECTED");
  });

  it("still short-circuits to empty in local execution mode", () => {
    loadConfigMock.mockReturnValue({ executionMode: "local" });
    expect(buildGalaxyContextBlock()).toBe("");
  });
});
