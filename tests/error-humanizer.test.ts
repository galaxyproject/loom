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

  it("explains the Google geo-block 400 instead of showing the raw payload", () => {
    // Shape @google/genai throws (and pi forwards verbatim) for a region block:
    // ApiError.message === JSON.stringify(errorBody). Note Google keys the error
    // on `status`/`code`, not the Anthropic-style `type`.
    const raw = JSON.stringify({
      error: {
        code: 400,
        message: "User location is not supported for the API use.",
        status: "FAILED_PRECONDITION",
      },
    });
    const result = humanizeAgentError(raw);
    expect(result.text).toMatch(/region/i);
    expect(result.text).not.toContain("{");
    expect(result.text).not.toContain("FAILED_PRECONDITION");
    expect(result.retriable).toBe(false);
  });

  // A surfaced transient provider error (overloaded / rate limit / 500) ends the
  // turn mid-task. The bare "Try again." gave the user no way to tell whether the
  // in-progress work (e.g. a figure write) had completed, so they couldn't act on
  // it (issue #316). Every retriable termination must say the turn was interrupted
  // and the task may be incomplete.
  describe("transient errors flag an interrupted task (issue #316)", () => {
    it("tells the user the task may be incomplete on a 500 api_error", () => {
      const raw = JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "Internal server error" },
      });
      const result = humanizeAgentError(raw);
      expect(result.retriable).toBe(true);
      // Keeps the upstream cause...
      expect(result.text).toContain("Internal server error");
      // ...and now states the turn was interrupted and may not have finished.
      expect(result.text).toMatch(/interrupted/i);
      expect(result.text).toMatch(/incomplete/i);
    });

    it("flags incompleteness for an overloaded_error too", () => {
      const raw = JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      });
      const result = humanizeAgentError(raw);
      expect(result.retriable).toBe(true);
      expect(result.text).toMatch(/overloaded/i);
      expect(result.text).toMatch(/incomplete/i);
    });

    it("flags incompleteness for a rate_limit_error too", () => {
      const raw = JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "slow down" },
      });
      const result = humanizeAgentError(raw);
      expect(result.retriable).toBe(true);
      expect(result.text).toContain("slow down");
      expect(result.text).toMatch(/incomplete/i);
    });

    it("flags incompleteness even when api_error carries no upstream message", () => {
      // A bare 500 (no message) is the exact shape behind issue #316; the note
      // has to land on the message-less branch too, not just the errMsg one.
      const raw = JSON.stringify({ type: "error", error: { type: "api_error" } });
      const result = humanizeAgentError(raw);
      expect(result.retriable).toBe(true);
      expect(result.text).toMatch(/incomplete/i);
      expect(result.text).not.toContain("{");
    });

    it("does not leak raw JSON noise while adding the note", () => {
      const raw = JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "Internal server error" },
        request_id: "req_abc",
      });
      const result = humanizeAgentError(raw);
      expect(result.text).not.toContain("{");
      expect(result.text).not.toContain("request_id");
    });
  });

  describe("opaque provider 'An unknown error occurred' (#320)", () => {
    // pi-ai's provider streams throw a bare `new Error("An unknown error
    // occurred")` whenever a turn ends with stopReason "error"/"aborted" -- for
    // Gemini that covers SAFETY, RECITATION, MALFORMED_FUNCTION_CALL, OTHER, etc.
    // (google-shared.ts mapStopReason). The detail is gone by the time it
    // reaches us, so the sentinel must become an actionable nudge instead of
    // being echoed verbatim.
    it("replaces the bare sentinel with an actionable message", () => {
      const result = humanizeAgentError("An unknown error occurred");
      expect(result.text).not.toBe("An unknown error occurred");
      expect(result.text.toLowerCase()).toMatch(/rephras|resend|summary|switch/);
      expect(result.retriable).toBe(false);
    });

    it("matches case-insensitively and tolerates a trailing period", () => {
      const result = humanizeAgentError("an unknown error occurred.");
      expect(result.text).not.toMatch(/^an unknown error occurred/i);
      expect(result.text.toLowerCase()).toMatch(/rephras|resend|summary|switch/);
    });

    it("does not misfire on a different, more specific error", () => {
      const raw = "Connection reset by peer";
      expect(humanizeAgentError(raw).text).toBe(raw);
    });

    it("does not swallow a bare string that merely embeds the phrase", () => {
      // The real sentinel is context-less. A bare error that happens to contain
      // the phrase carries its own detail, so it must pass through unchanged
      // rather than be relabeled with the generic nudge (regex is anchored).
      const raw = "Stream failed: an unknown error occurred mid-response";
      const result = humanizeAgentError(raw);
      expect(result.text).toBe(raw);
      expect(result.text.toLowerCase()).not.toMatch(/rephras|resend|summary|switch/);
    });

    it("defers to typed JSON handling when a structured error merely contains the phrase", () => {
      // The real pi-ai sentinel is always a bare string. A structured provider
      // error that happens to embed the phrase should still get its typed
      // treatment, not be swallowed by the sentinel catch.
      const raw = JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "An unknown error occurred upstream" },
      });
      const result = humanizeAgentError(raw);
      expect(result.text).toMatch(/upstream api error/i);
      expect(result.retriable).toBe(true);
    });
  });

  describe("context overflow", () => {
    it("humanizes the OpenAI-compatible context-length 400 (deepseek-v4-flash) into a /compact nudge", () => {
      // The verbatim string from issue #209 -- arrives as a plain string, not JSON.
      const raw =
        "400 This model's maximum context length is 1048565 tokens. However, you " +
        "requested 1133502 tokens (1133502 in the messages, 0 in the completion). " +
        "Please reduce the length of the messages or completion.";
      const result = humanizeAgentError(raw);
      expect(result.text).toMatch(/\/compact/);
      expect(result.text.toLowerCase()).toContain("context");
      // No raw provider noise (token counts / HTTP status) should leak through.
      expect(result.text).not.toContain("1048565");
      expect(result.text).not.toContain("1133502");
      expect(result.text).not.toContain("400");
      expect(result.retriable).toBe(false);
    });

    it("detects context overflow even when the provider wraps it in JSON", () => {
      const raw = JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 1048565 tokens. However you requested 1133502 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      });
      const result = humanizeAgentError(raw);
      expect(result.text).toMatch(/\/compact/);
      expect(result.text).not.toContain("1133502");
      expect(result.retriable).toBe(false);
    });

    it("detects an Anthropic-style prompt-too-long overflow", () => {
      const raw = JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 213462 tokens > 200000 maximum",
        },
      });
      const result = humanizeAgentError(raw);
      expect(result.text).toMatch(/\/compact/);
      expect(result.retriable).toBe(false);
    });

    it("does not misfire on rate-limit errors that mention tokens", () => {
      const raw = JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "rate limit exceeded: too many tokens per minute",
        },
      });
      const result = humanizeAgentError(raw);
      // Should stay on the rate-limit path, not the overflow path.
      expect(result.text).not.toMatch(/\/compact/);
      expect(result.retriable).toBe(true);
    });
  });
});
