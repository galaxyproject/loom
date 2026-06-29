import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("loadConfig ui theme defaults", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-config-theme-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function loadFreshConfig() {
    vi.resetModules();
    return import("../shared/loom-config.js");
  }

  it("defaults missing ui.theme to dark for existing and new configs", async () => {
    const { loadConfig } = await loadFreshConfig();
    expect(loadConfig().ui?.theme).toBe("dark");
  });

  it("preserves other ui preferences while normalizing invalid theme values", async () => {
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".loom", "config.json"),
      JSON.stringify({ ui: { theme: "sepia", showThinking: true } }),
    );

    const { loadConfig } = await loadFreshConfig();
    expect(loadConfig().ui).toMatchObject({ theme: "dark", showThinking: true });
  });

  it("normalizes the removed system theme preference to dark", async () => {
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".loom", "config.json"),
      JSON.stringify({ ui: { theme: "system" } }),
    );

    const { loadConfig } = await loadFreshConfig();
    expect(loadConfig().ui?.theme).toBe("dark");
  });
});
