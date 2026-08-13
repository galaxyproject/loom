import { describe, it, expect } from "vitest";
import {
  appendInvocationFailureHint,
  hasFailedTransition,
  INVOCATION_FAILED_HINT,
  INVOCATION_FAILURE_REFERENCE,
  JOB_FAILURE_REFERENCE,
} from "../extensions/loom/invocation-failure-hint";

function checkResult(results: unknown[]): string {
  return JSON.stringify({ success: true, checked: results.length, results }, null, 2);
}

const FAILED = { invocationId: "abc", label: "BWA", autoAction: "failed" };
const COMPLETED = { invocationId: "def", label: "QC", autoAction: "completed" };
const NO_ACTION = { invocationId: "ghi", label: "Pending" };

describe("hasFailedTransition", () => {
  it("detects a failed transition", () => {
    expect(hasFailedTransition(checkResult([FAILED]))).toBe(true);
  });

  it("detects a failure alongside other invocations", () => {
    expect(hasFailedTransition(checkResult([COMPLETED, NO_ACTION, FAILED]))).toBe(true);
  });

  it("ignores completed-only and still-running results", () => {
    expect(hasFailedTransition(checkResult([COMPLETED, NO_ACTION]))).toBe(false);
    expect(hasFailedTransition(checkResult([]))).toBe(false);
  });

  it("ignores a check_error autoAction -- that is a poll failure, not a run failure", () => {
    const errored = { invocationId: "x", autoAction: "check_error: boom" };
    expect(hasFailedTransition(checkResult([errored]))).toBe(false);
  });

  it("stays quiet on non-JSON text rather than regex-matching prose", () => {
    expect(hasFailedTransition("Workflow failed: 2 jobs errored")).toBe(false);
    expect(hasFailedTransition("")).toBe(false);
  });

  it("stays quiet on JSON without a results array", () => {
    expect(hasFailedTransition(JSON.stringify({ success: true }))).toBe(false);
    expect(hasFailedTransition(JSON.stringify({ results: "failed" }))).toBe(false);
  });
});

describe("appendInvocationFailureHint", () => {
  it("appends the hint to the block carrying the failure", () => {
    const content = [{ type: "text", text: checkResult([FAILED]) }];
    const out = appendInvocationFailureHint(content);
    expect(out).not.toBeNull();
    expect(out![0].text).toContain(INVOCATION_FAILED_HINT);
  });

  it("names both bundled references so job-level evidence is reachable", () => {
    const content = [{ type: "text", text: checkResult([FAILED]) }];
    const text = appendInvocationFailureHint(content)![0].text!;
    expect(text).toContain(INVOCATION_FAILURE_REFERENCE);
    expect(text).toContain(JOB_FAILURE_REFERENCE);
    expect(text).toContain('repo: "foundry"');
  });

  it("carries a self-contained imperative, not just a pointer", () => {
    // The #210/#249 lesson: a deterministic nudge can't depend on a pull for
    // the part that makes it actionable. Assert the actionable claims are
    // inline, so shrinking this to "go fetch a skill" fails the test.
    expect(INVOCATION_FAILED_HINT).toMatch(/report it to the user now/i);
    expect(INVOCATION_FAILED_HINT).toMatch(/invocation state and job state/i);
    expect(INVOCATION_FAILED_HINT).toMatch(/do not mark the plan step complete/i);
  });

  it("returns null when nothing failed", () => {
    expect(
      appendInvocationFailureHint([{ type: "text", text: checkResult([COMPLETED]) }]),
    ).toBeNull();
  });

  it("is idempotent", () => {
    const content = [{ type: "text", text: checkResult([FAILED]) }];
    const once = appendInvocationFailureHint(content)!;
    expect(appendInvocationFailureHint(once)).toBeNull();
  });

  it("does not mutate the original content array", () => {
    const original = { type: "text", text: checkResult([FAILED]) };
    const content = [original];
    appendInvocationFailureHint(content);
    expect(content[0]).toBe(original);
    expect(original.text).not.toContain(INVOCATION_FAILED_HINT);
  });

  it("leaves non-text blocks alone", () => {
    const content = [{ type: "image" }, { type: "text", text: checkResult([FAILED]) }] as {
      type: string;
      text?: string;
    }[];
    const out = appendInvocationFailureHint(content)!;
    expect(out[0]).toEqual({ type: "image" });
    expect(out[1].text).toContain(INVOCATION_FAILED_HINT);
  });

  it("returns null for content with no text blocks", () => {
    expect(appendInvocationFailureHint([{ type: "image" }])).toBeNull();
  });
});
