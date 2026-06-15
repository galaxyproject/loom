import { describe, it, expect } from "vitest";
import { isLocalShellAvailable, noLocalShellSpawnExtras } from "../app/src/main/local-shell.js";

describe("isLocalShellAvailable", () => {
  // Windows has no native bash; the remote-only desktop removes the bash tool.
  it("reports no local shell on win32", () => {
    expect(isLocalShellAvailable("win32")).toBe(false);
  });

  it.each(["darwin", "linux"])("reports a local shell on %s", (platform) => {
    expect(isLocalShellAvailable(platform)).toBe(true);
  });
});

describe("noLocalShellSpawnExtras", () => {
  // On a no-shell platform the brain is spawned with bash removed from the
  // advertised tool set (pi --exclude-tools) and flagged so its init-gate
  // rejects local-leg plans.
  it("removes bash + flags the brain on win32", () => {
    expect(noLocalShellSpawnExtras("win32")).toEqual({
      args: ["--exclude-tools", "bash"],
      env: { LOOM_LOCAL_SHELL: "off" },
    });
  });

  it.each(["darwin", "linux"])("adds nothing on %s", (platform) => {
    expect(noLocalShellSpawnExtras(platform)).toEqual({ args: [], env: {} });
  });
});
