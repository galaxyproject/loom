import { describe, expect, it } from "vitest";
import {
  GALAXY_RECONNECT_NUDGE,
  isGalaxyTransportError,
  transportNudgeDecision,
} from "../extensions/loom/galaxy-transport-error.js";

describe("isGalaxyTransportError", () => {
  it("matches the bare SDK 'Not connected' on a galaxy_* tool", () => {
    expect(
      isGalaxyTransportError("galaxy_get_histories", "Failed to call tool: Not connected"),
    ).toBe(true);
  });

  it("matches the -32001 request-timeout transport error", () => {
    expect(
      isGalaxyTransportError(
        "galaxy_download_dataset",
        "Failed to call tool: MCP error -32001: Request timed out",
      ),
    ).toBe(true);
  });

  it("matches the -32000 connection-closed transport error", () => {
    expect(
      isGalaxyTransportError(
        "galaxy_get_history_contents",
        "Failed to call tool: MCP error -32000: Connection closed",
      ),
    ).toBe(true);
  });

  it("does NOT match galaxy-mcp's own verbose auth error (needs galaxy_connect, not /mcp reconnect)", () => {
    expect(
      isGalaxyTransportError(
        "galaxy_get_histories",
        "Error: Not connected to Galaxy. Authenticate via OAuth or run connect() with your Galaxy URL and API key.",
      ),
    ).toBe(false);
  });

  it("ignores non-galaxy tools even with a matching message", () => {
    expect(isGalaxyTransportError("bash", "Failed to call tool: Not connected")).toBe(false);
  });

  it("ignores healthy galaxy results", () => {
    expect(
      isGalaxyTransportError("galaxy_get_histories", '{"histories": [], "success": true}'),
    ).toBe(false);
  });

  it("handles missing tool name / text", () => {
    expect(isGalaxyTransportError(undefined, "Not connected")).toBe(false);
    expect(isGalaxyTransportError("galaxy_get_histories", undefined)).toBe(false);
  });
});

describe("transportNudgeDecision", () => {
  it("fires the nudge once on the first transport error and disarms", () => {
    const d = transportNudgeDecision(
      true,
      "galaxy_get_histories",
      "Failed to call tool: Not connected",
    );
    expect(d.showNudge).toBe(true);
    expect(d.armed).toBe(false);
  });

  it("suppresses repeat nudges while disarmed (no spam during the retry loop)", () => {
    const d = transportNudgeDecision(
      false,
      "galaxy_get_histories",
      "Failed to call tool: Not connected",
    );
    expect(d.showNudge).toBe(false);
    expect(d.armed).toBe(false);
  });

  it("re-arms after a healthy galaxy call so a later outage nudges again", () => {
    const d = transportNudgeDecision(false, "galaxy_get_histories", '{"success": true}');
    expect(d.showNudge).toBe(false);
    expect(d.armed).toBe(true);
  });

  it("leaves state untouched for unrelated (non-galaxy) results", () => {
    expect(transportNudgeDecision(true, "bash", "anything")).toEqual({
      showNudge: false,
      armed: true,
    });
    expect(transportNudgeDecision(false, "read", "anything")).toEqual({
      showNudge: false,
      armed: false,
    });
  });

  it("exposes an actionable nudge message pointing at /mcp reconnect galaxy", () => {
    expect(GALAXY_RECONNECT_NUDGE).toMatch(/\/mcp reconnect galaxy/);
  });
});
