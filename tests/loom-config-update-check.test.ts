import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// loadConfig reads ~/.loom/config.json via os.homedir(). Point homedir at a
// temp dir so the test never touches the real config.
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cfg-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadConfig updateCheck default", () => {
  it("defaults updateCheck to true when absent", async () => {
    const { loadConfig } = await import("../shared/loom-config.js");
    expect(loadConfig().updateCheck).toBe(true);
  });
  it("preserves an explicit false", async () => {
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".loom", "config.json"),
      JSON.stringify({ updateCheck: false }),
    );
    const { loadConfig } = await import("../shared/loom-config.js");
    expect(loadConfig().updateCheck).toBe(false);
  });
});
