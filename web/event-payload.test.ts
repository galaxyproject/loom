import { describe, it, expect } from "vitest";
import { encodeEventPayload, decodeEventPayload } from "./event-payload.js";

/**
 * #439: the two halves of the web event wire disagreed. The server collapsed a
 * one-argument event to a bare value and left anything longer as an array; the
 * shim passed whatever arrived as a single argument. `sendEvent("agent:status",
 * "error", summary)` therefore reached `onAgentStatus((status, msg) => ...)` as
 * one array, and the footer pill rendered it as
 * "error,No LLM provider is configured, so the ag".
 */
function roundTrip(...args: unknown[]): unknown[] {
  // What actually crosses the socket is JSON, so round trip through it.
  const wire = JSON.parse(JSON.stringify({ _payload: encodeEventPayload(args) }));
  return decodeEventPayload(wire._payload);
}

describe("agent event payload round trip", () => {
  it("preserves a two-argument status event", () => {
    // The case that was broken, and the reason the pill showed a joined array.
    expect(roundTrip("error", "No LLM provider is configured.")).toEqual([
      "error",
      "No LLM provider is configured.",
    ]);
  });

  it("preserves a single string argument", () => {
    expect(roundTrip("running")).toEqual(["running"]);
  });

  it("preserves a single object argument", () => {
    const event = { type: "error", message: "boom" };
    expect(roundTrip(event)).toEqual([event]);
  });

  it("preserves an argument that is itself an array", () => {
    // The old format could not express this: a lone array argument was
    // indistinguishable from a multi-argument payload.
    expect(roundTrip(["a", "b"])).toEqual([["a", "b"]]);
  });

  it("preserves a zero-argument event", () => {
    expect(roundTrip()).toEqual([]);
  });

  it("tolerates the old bare-value form from a stale peer", () => {
    // A cached bundle must degrade to the previous behavior, not spread a
    // string into individual characters.
    expect(decodeEventPayload("stopped")).toEqual(["stopped"]);
    expect(decodeEventPayload({ type: "error" })).toEqual([{ type: "error" }]);
  });
});
