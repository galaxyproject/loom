import { describe, it, expect } from "vitest";
import {
  shouldHintJobRun,
  appendJobHint,
  registerJobStatusHint,
  JOB_SUBMITTED_HINT,
} from "../extensions/loom/job-status-hint";

describe("JOB_SUBMITTED_HINT", () => {
  it("points get_job_details at an output dataset id, not a job id", () => {
    // galaxy_get_job_details takes a dataset_id (the output dataset), not a jobId.
    expect(JOB_SUBMITTED_HINT).toContain("galaxy_get_job_details");
    expect(JOB_SUBMITTED_HINT).toContain("output dataset id");
    expect(JOB_SUBMITTED_HINT).not.toContain("job id");
  });
});

describe("shouldHintJobRun", () => {
  it("fires for a successful galaxy_run_tool result", () => {
    expect(shouldHintJobRun("galaxy_run_tool", false)).toBe(true);
  });

  it("fires for galaxy_run_user_tool (isError undefined)", () => {
    expect(shouldHintJobRun("galaxy_run_user_tool", undefined)).toBe(true);
  });

  it("does not fire when the tool call itself errored", () => {
    // An errored run_tool already shows the model a failure -- no nudge needed.
    expect(shouldHintJobRun("galaxy_run_tool", true)).toBe(false);
  });

  it("does not fire for unrelated tools, incl. workflow invocation (its own poller)", () => {
    expect(shouldHintJobRun("galaxy_get_history", false)).toBe(false);
    expect(shouldHintJobRun("galaxy_invoke_workflow", false)).toBe(false);
    expect(shouldHintJobRun("read", false)).toBe(false);
  });

  it("does not fire when toolName is missing", () => {
    expect(shouldHintJobRun(undefined, false)).toBe(false);
  });
});

describe("appendJobHint", () => {
  it("appends the reminder to the first text block, preserving the original text", () => {
    const content = [{ type: "text", text: "Started tool trim_galore (job abc123)" }];
    const out = appendJobHint(content);
    expect(out).not.toBeNull();
    expect(out![0].text).toContain("Started tool trim_galore");
    expect(out![0].text).toContain(JOB_SUBMITTED_HINT);
  });

  it("does not mutate the original content array", () => {
    const content = [{ type: "text", text: "Started tool x" }];
    appendJobHint(content);
    expect(content[0].text).toBe("Started tool x");
  });

  it("is idempotent -- a second pass adds nothing", () => {
    const content = [{ type: "text", text: "Started tool x" }];
    const once = appendJobHint(content)!;
    expect(appendJobHint(once)).toBeNull();
  });

  it("adds a text item when the result carries no text block", () => {
    const content = [{ type: "resource" } as { type: string; text?: string }];
    const out = appendJobHint(content);
    expect(out).not.toBeNull();
    expect(out!.some((c) => c.type === "text" && c.text?.includes(JOB_SUBMITTED_HINT))).toBe(true);
  });
});

describe("registerJobStatusHint", () => {
  function fakePi() {
    const handlers = new Map<string, (e: unknown) => unknown>();
    const pi = {
      on: (evt: string, h: (e: unknown) => unknown) => handlers.set(evt, h),
    } as unknown as Parameters<typeof registerJobStatusHint>[0];
    return { pi, handlers };
  }

  it("appends the hint onto a successful run_tool tool-result message", () => {
    const { pi, handlers } = fakePi();
    registerJobStatusHint(pi);
    const res = handlers.get("message_end")!({
      message: {
        role: "toolResult",
        isError: false,
        toolName: "galaxy_run_tool",
        content: [{ type: "text", text: "Started tool trim_galore" }],
      },
    }) as { message: { content: { type: string; text?: string }[] } };
    expect(res.message.content[0].text).toContain(JOB_SUBMITTED_HINT);
  });

  it("ignores an errored run_tool message", () => {
    const { pi, handlers } = fakePi();
    registerJobStatusHint(pi);
    const res = handlers.get("message_end")!({
      message: {
        role: "toolResult",
        isError: true,
        toolName: "galaxy_run_tool",
        content: [{ type: "text", text: "boom" }],
      },
    });
    expect(res).toBeUndefined();
  });

  it("ignores a non-toolResult message", () => {
    const { pi, handlers } = fakePi();
    registerJobStatusHint(pi);
    const res = handlers.get("message_end")!({
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(res).toBeUndefined();
  });
});
