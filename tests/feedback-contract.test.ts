import { describe, it, expect } from "vitest";
import {
  validateFeedbackPayload,
  SCHEMA_VERSION,
  FEEDBACK_ROUTE,
  FEEDBACK_KEY_HEADER,
  formatActivityTail,
  capFeedbackPayload,
} from "../shared/feedback-contract.js";

const valid = {
  schemaVersion: 1,
  source: "orbit",
  title: "It crashed",
  body: "Steps: ...",
  clientTs: "2026-06-02T00:00:00.000Z",
};

describe("feedback contract", () => {
  it("exposes stable wire constants", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(FEEDBACK_ROUTE).toBe("/feedback");
    expect(FEEDBACK_KEY_HEADER).toBe("X-Orbit-Feedback-Key");
  });

  it("accepts a minimal valid payload", () => {
    expect(validateFeedbackPayload(valid)).toBe(true);
  });

  it("rejects missing title", () => {
    expect(validateFeedbackPayload({ ...valid, title: "" })).toBe(false);
  });

  it("rejects an unknown source", () => {
    expect(validateFeedbackPayload({ ...valid, source: "evil" })).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(validateFeedbackPayload(null)).toBe(false);
    expect(validateFeedbackPayload("nope")).toBe(false);
  });

  it("rejects a wrong schemaVersion, non-string body, or missing clientTs", () => {
    expect(validateFeedbackPayload({ ...valid, schemaVersion: 2 })).toBe(false);
    expect(validateFeedbackPayload({ ...valid, body: 123 })).toBe(false);
    expect(
      validateFeedbackPayload({ schemaVersion: 1, source: "orbit", title: "t", body: "b" }),
    ).toBe(false);
  });

  it("accepts an optional string testerId and rejects a non-string one", () => {
    expect(validateFeedbackPayload({ ...valid, testerId: "orbit-007" })).toBe(true);
    expect(validateFeedbackPayload({ ...valid, testerId: 7 })).toBe(false);
  });
});

describe("formatActivityTail", () => {
  it("renders tool name, redacted args, and result summary with a status flag", () => {
    const out = formatActivityTail([
      {
        timestamp: "t1",
        kind: "tool.start",
        source: "agent",
        payload: { toolName: "bash", args: { command: "ls" } },
      },
      {
        timestamp: "t2",
        kind: "tool.end",
        source: "agent",
        payload: { toolName: "bash", isError: false, resultSummary: "ok" },
      },
    ]);
    expect(out).toContain("t1 tool.start bash");
    expect(out).toContain('args={"command":"ls"}');
    expect(out).toContain("t2 tool.end bash ✓ ok");
  });

  it("flags errored tools with ✗ and passes the summary through verbatim", () => {
    const out = formatActivityTail([
      {
        timestamp: "t",
        kind: "tool.end",
        source: "agent",
        payload: {
          toolName: "galaxy_invoke_workflow",
          isError: true,
          resultSummary: "ERROR: bad adapter",
        },
      },
    ]);
    expect(out).toBe("t tool.end galaxy_invoke_workflow ✗ ERROR: bad adapter");
  });

  it("renders user prompts and falls back to kind+source for unknown kinds", () => {
    const out = formatActivityTail([
      { timestamp: "t1", kind: "user.prompt", source: "user", payload: { text: "hello there" } },
      { timestamp: "t2", kind: "guard.decision", source: "exec-guard", payload: {} },
    ]);
    expect(out).toContain("t1 user.prompt hello there");
    expect(out).toContain("t2 guard.decision (exec-guard)");
  });

  it("trims oldest events to fit the byte budget, keeping the newest", () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      timestamp: `t${i}`,
      kind: "tool.end",
      source: "agent",
      payload: { toolName: "bash", isError: false, resultSummary: "x".repeat(400) },
    }));
    const out = formatActivityTail(events, { maxBytes: 4096 });
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(4096);
    expect(out).toContain("t199 "); // newest kept
    expect(out.startsWith("t0 ")).toBe(false); // oldest dropped
  });

  it("hard-slices a single over-budget line to fit the byte budget", () => {
    const out = formatActivityTail(
      [
        {
          timestamp: "t",
          kind: "tool.end",
          source: "agent",
          payload: { toolName: "x", isError: false, resultSummary: "y".repeat(600) },
        },
      ],
      { maxBytes: 100 },
    );
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(100);
  });

  it("returns an empty string for no events", () => {
    expect(formatActivityTail([])).toBe("");
  });

  it("flattens embedded newlines so each event stays exactly one line", () => {
    const out = formatActivityTail([
      {
        timestamp: "t1",
        kind: "user.prompt",
        source: "user",
        payload: { text: "first line\nsecond line" },
      },
      {
        timestamp: "t2",
        kind: "tool.end",
        source: "agent",
        payload: {
          toolName: "bash",
          isError: true,
          resultSummary: "Error: boom\nstack frame",
        },
      },
    ]);
    expect(out).toContain("t1 user.prompt first line second line");
    expect(out).toContain("t2 tool.end bash ✗ Error: boom stack frame");
    expect(out.split("\n").length).toBe(2);
  });

  it("collapses bare carriage returns and CRLF runs, not just LF", () => {
    const out = formatActivityTail([
      {
        timestamp: "t",
        kind: "user.prompt",
        source: "user",
        payload: { text: "downloading\r99%\r\ndone" },
      },
    ]);
    expect(out).toBe("t user.prompt downloading 99% done");
    expect(out).not.toMatch(/[\r\n]/);
  });

  it("handles multibyte characters during hard-slicing without splitting unicode code points", () => {
    const emoji = "🐻❄️🔥🌲";
    const out = formatActivityTail(
      [
        {
          timestamp: "t",
          kind: "user.prompt",
          source: "user",
          payload: { text: emoji.repeat(50) },
        },
      ],
      { maxBytes: 50 },
    );
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(50);
    expect(out.endsWith("\uFFFD")).toBe(false);
  });
});

describe("capFeedbackPayload", () => {
  const base = { schemaVersion: 1, source: "orbit", title: "t", body: "b", clientTs: "now" };

  it("returns the payload unchanged when under budget", () => {
    const p = { ...base, activityTail: "a", shellTail: "s" };
    expect(capFeedbackPayload(p)).toEqual(p);
  });

  it("trims activityTail before shellTail and keeps the result under budget", () => {
    const big = Array.from({ length: 10000 }, (_, i) => `a${i}`).join("\n");
    const p = { ...base, activityTail: big, shellTail: "keep-me" };
    const capped = capFeedbackPayload(p, { maxTotalBytes: 8000 });
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(8000);
    expect(capped.shellTail).toBe("keep-me"); // shell untouched
    expect(capped.activityTail.length).toBeLessThan(big.length); // activity sacrificed first
  });
});
