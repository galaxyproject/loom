import { describe, expect, it } from "vitest";
import { humanizeAgentError } from "../app/src/renderer/chat/error-humanizer.js";

describe("humanizeAgentError", () => {
  it("unwraps Anthropic overloaded_error into a friendly message", () => {
    const raw = JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
      request_id: "req_test",
    });
    const result = humanizeAgentError(raw);
    expect(result.text).toMatch(/overloaded/i);
    expect(result.text).not.toContain("request_id");
    expect(result.text).not.toContain("{");
    expect(result.retriable).toBe(true);
  });

  it("flags authentication_error as non-retriable with a key-reminder", () => {
    const raw = JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    const result = humanizeAgentError(raw);
    expect(result.retriable).toBe(false);
    expect(result.text.toLowerCase()).toContain("api key");
  });

  it("includes the upstream message for invalid_request_error", () => {
    const raw = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "max_tokens too big" },
    });
    const result = humanizeAgentError(raw);
    expect(result.text).toContain("max_tokens too big");
    expect(result.retriable).toBe(false);
  });

  it("falls back to the raw string when JSON is unparseable", () => {
    const raw = "Connection reset by peer";
    expect(humanizeAgentError(raw).text).toBe(raw);
  });

  it("handles empty input", () => {
    expect(humanizeAgentError("").text).toBe("Unknown error");
    expect(humanizeAgentError(null).text).toBe("Unknown error");
    expect(humanizeAgentError(undefined).text).toBe("Unknown error");
  });

  it("handles unknown error types by stitching type + message", () => {
    const raw = JSON.stringify({
      type: "error",
      error: { type: "weird_new_error", message: "something broke" },
    });
    const result = humanizeAgentError(raw);
    expect(result.text).toContain("weird_new_error");
    expect(result.text).toContain("something broke");
    expect(result.retriable).toBe(false);
  });

  it("does not try to parse strings that don't look like JSON", () => {
    const raw = "Just a plain error string {not really json";
    expect(humanizeAgentError(raw).text).toBe(raw);
  });
});
