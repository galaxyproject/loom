import { describe, expect, it } from "vitest";
import {
  ALL_NUDGES_ARMED,
  GALAXY_RECONNECT_NUDGE,
  GALAXY_TIMEOUT_NUDGE,
  isGalaxyTransportError,
  transportNudgeDecision,
} from "../extensions/loom/galaxy-transport-error.js";

const DROPPED = "Failed to call tool: Not connected";
const TIMED_OUT = "Failed to call tool: Request timed out";

describe("isGalaxyTransportError", () => {
  it("matches the bare SDK 'Not connected' on a galaxy_* tool", () => {
    expect(
      isGalaxyTransportError("mcp__galaxy__get_histories", "Failed to call tool: Not connected"),
    ).toBe(true);
  });

  it("matches the -32001 request-timeout transport error", () => {
    expect(
      isGalaxyTransportError(
        "mcp__galaxy__download_dataset",
        "Failed to call tool: MCP error -32001: Request timed out",
      ),
    ).toBe(true);
  });

  it("matches the -32000 connection-closed transport error", () => {
    expect(
      isGalaxyTransportError(
        "mcp__galaxy__get_history_contents",
        "Failed to call tool: MCP error -32000: Connection closed",
      ),
    ).toBe(true);
  });

  it("does NOT match galaxy-mcp's own verbose auth error (needs mcp__galaxy__connect, not /mcp reconnect)", () => {
    expect(
      isGalaxyTransportError(
        "mcp__galaxy__get_histories",
        "Error: Not connected to Galaxy. Authenticate via OAuth or run connect() with your Galaxy URL and API key.",
      ),
    ).toBe(false);
  });

  it("ignores non-galaxy tools even with a matching message", () => {
    expect(isGalaxyTransportError("bash", "Failed to call tool: Not connected")).toBe(false);
  });

  it("ignores healthy galaxy results", () => {
    expect(
      isGalaxyTransportError("mcp__galaxy__get_histories", '{"histories": [], "success": true}'),
    ).toBe(false);
  });

  it("handles missing tool name / text", () => {
    expect(isGalaxyTransportError(undefined, "Not connected")).toBe(false);
    expect(isGalaxyTransportError("mcp__galaxy__get_histories", undefined)).toBe(false);
  });
});

describe("transportNudgeDecision", () => {
  it("fires the nudge once on the first transport error and disarms that kind", () => {
    const d = transportNudgeDecision(ALL_NUDGES_ARMED, "mcp__galaxy__get_histories", DROPPED);
    expect(d.nudge).toBe(GALAXY_RECONNECT_NUDGE);
    expect(d.armed).toEqual({ timeout: true, dropped: false });
  });

  it("suppresses repeat nudges while disarmed (no spam during the retry loop)", () => {
    const d = transportNudgeDecision(
      { timeout: true, dropped: false },
      "mcp__galaxy__get_histories",
      DROPPED,
    );
    expect(d.nudge).toBeNull();
    expect(d.armed).toEqual({ timeout: true, dropped: false });
  });

  it("re-arms both kinds after a healthy galaxy call so a later outage nudges again", () => {
    const d = transportNudgeDecision(
      { timeout: false, dropped: false },
      "mcp__galaxy__get_histories",
      '{"success": true}',
    );
    expect(d.nudge).toBeNull();
    expect(d.armed).toEqual({ timeout: true, dropped: true });
  });

  it("leaves state untouched for unrelated (non-galaxy) results", () => {
    expect(transportNudgeDecision(ALL_NUDGES_ARMED, "bash", "anything")).toEqual({
      nudge: null,
      armed: ALL_NUDGES_ARMED,
    });
    const halfArmed = { timeout: false, dropped: true };
    expect(transportNudgeDecision(halfArmed, "read", "anything")).toEqual({
      nudge: null,
      armed: halfArmed,
    });
  });

  // The reason arming is per kind: these two need opposite advice, so one must
  // not be able to silence the other before the user has seen it.
  it("still warns about a drop that follows a timeout", () => {
    const first = transportNudgeDecision(ALL_NUDGES_ARMED, "mcp__galaxy__run_tool", TIMED_OUT);
    expect(first.nudge).toBe(GALAXY_TIMEOUT_NUDGE);
    const second = transportNudgeDecision(first.armed, "mcp__galaxy__run_tool", DROPPED);
    expect(second.nudge).toBe(GALAXY_RECONNECT_NUDGE);
    expect(second.armed).toEqual({ timeout: false, dropped: false });
  });

  it("still warns about a timeout that follows a drop", () => {
    const first = transportNudgeDecision(ALL_NUDGES_ARMED, "mcp__galaxy__run_tool", DROPPED);
    expect(first.nudge).toBe(GALAXY_RECONNECT_NUDGE);
    const second = transportNudgeDecision(first.armed, "mcp__galaxy__run_tool", TIMED_OUT);
    expect(second.nudge).toBe(GALAXY_TIMEOUT_NUDGE);
  });

  it("leads with the agent's reconnect and keeps /mcp reconnect as the user's fallback", () => {
    expect(GALAXY_RECONNECT_NUDGE).toContain("agent can reconnect");
    expect(GALAXY_RECONNECT_NUDGE).toContain("if that fails, run /mcp reconnect galaxy");
    expect(GALAXY_RECONNECT_NUDGE).not.toContain("Orbit");
  });

  // The timeout advice must stay followable: no mcp.json path (loom rewrites
  // that file), and no claim that the server is healthy.
  it("keeps the timeout advice actionable and honest", () => {
    expect(GALAXY_TIMEOUT_NUDGE).not.toMatch(/mcp\.json/);
    expect(GALAXY_TIMEOUT_NUDGE).not.toMatch(/is responding/);
    expect(GALAXY_TIMEOUT_NUDGE).toContain("result is unknown");
    expect(GALAXY_TIMEOUT_NUDGE).not.toMatch(/Try asking|restart it/);
  });
});
