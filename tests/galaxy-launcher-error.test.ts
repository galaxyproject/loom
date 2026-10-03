import { describe, expect, it } from "vitest";
import {
  GALAXY_UVX_MISSING_NUDGE,
  galaxyLauncherGuidance,
  isGalaxyLauncherError,
} from "../extensions/loom/galaxy-launcher-error.js";
import { planUvxWarning } from "../extensions/loom/session-lifecycle.js";

describe("isGalaxyLauncherError", () => {
  it("matches the raw spawn failure a missing uvx produces", () => {
    expect(
      isGalaxyLauncherError("mcp__galaxy__connect", "Failed to call tool: spawn uvx ENOENT"),
    ).toBe(true);
  });

  it("matches when another layer reorders the runner and the errno", () => {
    expect(
      isGalaxyLauncherError("mcp__galaxy__get_histories", "MCP launch failed: ENOENT running uvx"),
    ).toBe(true);
  });

  it("ignores non-galaxy tools so a missing binary elsewhere is not misattributed", () => {
    expect(isGalaxyLauncherError("bash", "spawn uvx ENOENT")).toBe(false);
  });

  it("does not match the transport drop that /mcp reconnect actually fixes", () => {
    // The whole point of the split: this one must fall through to the
    // reconnect nudge instead of telling the user to install software.
    expect(
      isGalaxyLauncherError("mcp__galaxy__get_histories", "Failed to call tool: Not connected"),
    ).toBe(false);
    expect(isGalaxyLauncherError("mcp__galaxy__get_histories", "Connection closed (-32000)")).toBe(
      false,
    );
  });

  it("does not match galaxy-mcp's own auth error", () => {
    expect(
      isGalaxyLauncherError(
        "mcp__galaxy__get_histories",
        "Not connected to Galaxy. Authenticate via OAuth or run connect()...",
      ),
    ).toBe(false);
  });

  it("ignores a missing tool name or empty text", () => {
    expect(isGalaxyLauncherError(undefined, "spawn uvx ENOENT")).toBe(false);
    expect(isGalaxyLauncherError("mcp__galaxy__connect", undefined)).toBe(false);
    expect(isGalaxyLauncherError("mcp__galaxy__connect", "")).toBe(false);
  });

  it("steers away from reconnecting, which cannot fix a missing runner", () => {
    expect(GALAXY_UVX_MISSING_NUDGE).toMatch(/uv/i);
    expect(GALAXY_UVX_MISSING_NUDGE).toMatch(/not help/i);
  });

  it("reuses the CLI notice so the two surfaces cannot drift", () => {
    expect(galaxyLauncherGuidance()).toContain("uvx");
    expect(galaxyLauncherGuidance()).toContain("astral.sh/uv");
  });
});

describe("planUvxWarning", () => {
  it("warns when Galaxy is usable but the runner is missing", () => {
    const action = planUvxWarning("usable", false);
    expect(action).not.toBeNull();
    expect(action?.kind).toBe("notify");
    expect(action?.kind === "notify" && action.level).toBe("warning");
  });

  it("stays quiet when uvx is present", () => {
    expect(planUvxWarning("usable", true)).toBeNull();
  });

  it("stays quiet with no Galaxy configured -- nothing to launch yet", () => {
    expect(planUvxWarning("none", false)).toBeNull();
  });

  it("stays quiet when credentials are already unusable, which warns on its own", () => {
    expect(planUvxWarning("configured-unusable", false)).toBeNull();
  });
});
