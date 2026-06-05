import { describe, it, expect } from "vitest";
import { isForwardableUiResponse } from "./rpc-guard.js";

describe("isForwardableUiResponse", () => {
  it("accepts a genuine extension UI response", () => {
    expect(isForwardableUiResponse({ type: "extension_ui_response", id: "x", value: 0 })).toBe(
      true,
    );
  });

  // The core of the RPC-bash escape fix: any other command type a client tries
  // to smuggle through the agent:ui-response channel must be refused.
  it.each([
    { type: "bash", command: "cat /etc/passwd && env", id: "x" },
    { type: "abort_bash" },
    { type: "prompt", message: "hi" },
    { type: "get_session_stats" },
    { type: "switch_session" },
  ])("rejects a smuggled %p command", (payload) => {
    expect(isForwardableUiResponse(payload)).toBe(false);
  });

  it("rejects payloads with no type", () => {
    expect(isForwardableUiResponse({ id: "x" })).toBe(false);
  });

  it.each([null, undefined, 42, "extension_ui_response", []])(
    "rejects non-object payload %p",
    (payload) => {
      expect(isForwardableUiResponse(payload)).toBe(false);
    },
  );
});
