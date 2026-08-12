import { describe, expect, it } from "vitest";
import {
  applyJobPollUpdate,
  findJobBlocks,
  isTerminalJobState,
  jobStatusFromGalaxyState,
  renderJobYaml,
  upsertJobBlock,
  type JobYaml,
} from "../extensions/loom/galaxy-job-block.js";

const job: JobYaml = {
  jobId: "abc123",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-1-step-3",
  label: "BWA alignment",
  toolId: "bwa_mem",
  submittedAt: "2026-08-12T15:30:00Z",
  status: "in_progress",
};

describe("job block round-trip", () => {
  it("renders and parses back to the same record", () => {
    const parsed = findJobBlocks(renderJobYaml(job));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      jobId: "abc123",
      label: "BWA alignment",
      toolId: "bwa_mem",
      status: "in_progress",
    });
  });

  it("survives a label containing YAML punctuation", () => {
    const tricky = { ...job, label: "align: sample #2, rep 1" };
    const parsed = findJobBlocks(renderJobYaml(tricky));
    expect(parsed[0].label).toBe("align: sample #2, rep 1");
  });

  it("skips a block with no job_id rather than throwing", () => {
    const content = "```loom-job\nlabel: orphan\n```\n";
    expect(findJobBlocks(content)).toEqual([]);
  });

  it("ignores loom-invocation blocks, which poll a different endpoint", () => {
    const content = "```loom-invocation\ninvocation_id: inv1\nstatus: in_progress\n```\n";
    expect(findJobBlocks(content)).toEqual([]);
  });
});

describe("upsertJobBlock", () => {
  it("appends when the job is new and preserves existing prose", () => {
    const out = upsertJobBlock("# Notebook\n\nSome notes.\n", job);
    expect(out).toContain("# Notebook");
    expect(out).toContain("Some notes.");
    expect(findJobBlocks(out)).toHaveLength(1);
  });

  it("replaces in place rather than duplicating on re-record", () => {
    const once = upsertJobBlock("", job);
    const twice = upsertJobBlock(once, { ...job, status: "completed" });
    const blocks = findJobBlocks(twice);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("completed");
  });

  it("keeps other jobs untouched", () => {
    const two = upsertJobBlock(upsertJobBlock("", job), { ...job, jobId: "def456", label: "fastp" });
    const updated = upsertJobBlock(two, { ...job, status: "failed" });
    const blocks = findJobBlocks(updated);
    expect(blocks).toHaveLength(2);
    expect(blocks.find((b) => b.jobId === "def456")?.status).toBe("in_progress");
    expect(blocks.find((b) => b.jobId === "abc123")?.status).toBe("failed");
  });
});

describe("Galaxy state mapping", () => {
  it("treats ok as finished", () => {
    expect(isTerminalJobState("ok")).toBe(true);
    expect(jobStatusFromGalaxyState("ok")).toBe("completed");
  });

  it("treats error and deleted as failed", () => {
    for (const s of ["error", "deleted"]) {
      expect(isTerminalJobState(s)).toBe(true);
      expect(jobStatusFromGalaxyState(s)).toBe("failed");
    }
  });

  it("keeps running states in flight", () => {
    for (const s of ["new", "queued", "running", "waiting"]) {
      expect(isTerminalJobState(s)).toBe(false);
      expect(jobStatusFromGalaxyState(s)).toBe("in_progress");
    }
  });

  it("does not strand a paused job as failed -- it resumes when inputs land", () => {
    expect(isTerminalJobState("paused")).toBe(false);
    expect(jobStatusFromGalaxyState("paused")).toBe("in_progress");
  });

  it("treats an unknown or missing state as still running", () => {
    expect(isTerminalJobState(undefined)).toBe(false);
    expect(jobStatusFromGalaxyState("some_future_state")).toBe("in_progress");
  });
});

describe("applyJobPollUpdate", () => {
  it("writes only poll-owned fields, preserving a concurrent label edit", () => {
    const recorded = upsertJobBlock("", job);
    const edited = recorded.replace("label: BWA alignment", "label: BWA alignment (rep 2)");
    const polled = applyJobPollUpdate(edited, {
      jobId: "abc123",
      status: "completed",
      galaxyState: "ok",
      lastPolledAt: "2026-08-12T16:00:00Z",
    });
    const block = findJobBlocks(polled)[0];
    expect(block.label).toBe("BWA alignment (rep 2)"); // the agent's edit survives
    expect(block.status).toBe("completed");
    expect(block.galaxyState).toBe("ok");
    expect(block.notebookAnchor).toBe("plan-1-step-3");
  });

  it("is a no-op for a job id the notebook does not carry", () => {
    const content = upsertJobBlock("", job);
    const out = applyJobPollUpdate(content, {
      jobId: "not-here",
      status: "completed",
      lastPolledAt: "2026-08-12T16:00:00Z",
    });
    expect(out).toBe(content);
  });
});
