import { describe, it, expect } from "vitest";
import {
  findInvocationBlocks,
  upsertInvocationBlock,
  applyInvocationUpdates,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";
import {
  findJobBlocks,
  upsertJobBlock,
  applyJobPollUpdate,
  type JobYaml,
} from "../extensions/loom/galaxy-job-block";
import {
  mergeHarnessFields,
  pickHarnessFields,
  stripHarnessFields,
  type HarnessBlockFields,
} from "../extensions/loom/harness-block-fields";
import { parseInvocationBlocks } from "../app/src/renderer/galaxy-invocations.js";

const AGENT_INVOCATION: InvocationYaml = {
  invocationId: "ff1e2d3c4b5a6978",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-3",
  label: "BWA alignment",
  submittedAt: "2026-09-16T15:30:00Z",
  status: "in_progress",
};

const AGENT_JOB: JobYaml = {
  jobId: "aa11bb22cc33dd44",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-3",
  label: "BWA alignment",
  submittedAt: "2026-09-16T15:30:00Z",
  status: "in_progress",
};

const HARNESS: HarnessBlockFields = {
  attemptId: "01K5CJ6XWQ8QK4S2M7E9V0TZ3B",
  historyId: "0a248a1f62a0cc04",
  submittedBy: "harness",
  enrichment: "pending",
  enrichmentAttempts: 0,
};

// `server_verified` is not a harness field -- it is the record tools' own
// tri-state (see harness-block-fields.ts) and rides on the block object, so
// the tests that care about it put it there.

describe("harness block fields: round trip", () => {
  it("writes and reads every field on a loom-invocation block", () => {
    const content = upsertInvocationBlock(
      "",
      { ...AGENT_INVOCATION, serverVerified: true },
      {
        ...HARNESS,
        enrichment: "complete",
        enrichmentAttempts: 2,
        jobs: [
          {
            jobId: "job1",
            toolId: "bwa_mem",
            toolVersion: "0.7.17",
            state: "ok",
            outputs: [{ id: "ds1", ext: "bam", dbkey: "hg38" }],
          },
        ],
        drift: [{ toolId: "bwa_mem", from: "0.7.17", to: "0.7.18" }],
      },
    );

    const [parsed] = findInvocationBlocks(content);
    expect(parsed.attemptId).toBe("01K5CJ6XWQ8QK4S2M7E9V0TZ3B");
    expect(parsed.historyId).toBe("0a248a1f62a0cc04");
    expect(parsed.submittedBy).toBe("harness");
    expect(parsed.serverVerified).toBe(true);
    expect(parsed.enrichment).toBe("complete");
    expect(parsed.enrichmentAttempts).toBe(2);
    expect(parsed.jobs).toEqual([
      {
        jobId: "job1",
        toolId: "bwa_mem",
        toolVersion: "0.7.17",
        state: "ok",
        outputs: [{ id: "ds1", ext: "bam", dbkey: "hg38" }],
      },
    ]);
    expect(parsed.drift).toEqual([{ toolId: "bwa_mem", from: "0.7.17", to: "0.7.18" }]);
  });

  it("writes and reads every field on a loom-job block", () => {
    const content = upsertJobBlock(
      "",
      { ...AGENT_JOB, serverVerified: true },
      {
        ...HARNESS,
        jobs: [{ jobId: "aa11bb22cc33dd44", toolId: "bwa_mem", toolVersion: "0.7.17" }],
      },
    );

    const [parsed] = findJobBlocks(content);
    expect(parsed.attemptId).toBe("01K5CJ6XWQ8QK4S2M7E9V0TZ3B");
    expect(parsed.historyId).toBe("0a248a1f62a0cc04");
    expect(parsed.submittedBy).toBe("harness");
    expect(parsed.serverVerified).toBe(true);
    expect(parsed.enrichment).toBe("pending");
    expect(parsed.jobs).toEqual([
      { jobId: "aa11bb22cc33dd44", toolId: "bwa_mem", toolVersion: "0.7.17" },
    ]);
  });

  it("leaves a pre-harness block byte-identical", () => {
    const legacy = [
      "```loom-invocation",
      "invocation_id: ff1e2d3c4b5a6978",
      "galaxy_server_url: https://usegalaxy.org",
      "notebook_anchor: plan-a-step-3",
      "label: BWA alignment",
      "submitted_at: 2026-09-16T15:30:00Z",
      "status: in_progress",
      'summary: ""',
      "```",
      "",
    ].join("\n");

    const [parsed] = findInvocationBlocks(legacy);
    expect(parsed.submittedBy).toBeUndefined();
    expect(parsed.serverVerified).toBeUndefined();

    // Rewriting it emits no harness keys at all, so a notebook that predates
    // them stays exactly as legible as it was.
    const rewritten = upsertInvocationBlock(legacy, parsed);
    for (const key of [
      "attempt_id",
      "history_id",
      "submitted_by",
      "server_verified",
      "enrichment",
      "jobs:",
      "drift:",
    ]) {
      expect(rewritten).not.toContain(key);
    }
    expect(findInvocationBlocks(rewritten)[0]).toEqual(parsed);
  });
});

describe("harness block fields: the agent cannot write them", () => {
  // The whole value of `submitted_by: harness` is that only the harness can
  // put it there.
  const forged = {
    ...AGENT_INVOCATION,
    ...HARNESS,
    submittedBy: "harness" as const,
  };

  it("drops harness fields supplied on a brand-new block", () => {
    const content = upsertInvocationBlock("", forged);
    expect(content).not.toContain("submitted_by");
    expect(content).not.toContain("attempt_id");

    const [parsed] = findInvocationBlocks(content);
    expect(parsed.submittedBy).toBeUndefined();
  });

  it("drops harness fields on a job block too", () => {
    const content = upsertJobBlock("", { ...AGENT_JOB, ...HARNESS });
    expect(content).not.toContain("submitted_by");
    expect(content).not.toContain("attempt_id");
  });

  it("cannot overwrite what the harness already recorded", () => {
    const recorded = upsertInvocationBlock("", AGENT_INVOCATION, HARNESS);
    // An agent re-record with a different label, trying to relabel provenance
    // at the same time.
    const rewritten = upsertInvocationBlock(recorded, {
      ...AGENT_INVOCATION,
      label: "renamed by the agent",
      attemptId: "01FORGEDFORGEDFORGEDFORGED",
      submittedBy: "harness",
      historyId: "deadbeefdeadbeef",
    });

    const [parsed] = findInvocationBlocks(rewritten);
    expect(parsed.label).toBe("renamed by the agent");
    expect(parsed.attemptId).toBe(HARNESS.attemptId);
    expect(parsed.historyId).toBe(HARNESS.historyId);
  });

  it("carries harness fields through an ordinary agent rewrite", () => {
    const recorded = upsertInvocationBlock(
      "",
      { ...AGENT_INVOCATION, serverVerified: true },
      HARNESS,
    );
    const rewritten = upsertInvocationBlock(recorded, {
      ...AGENT_INVOCATION,
      notebookAnchor: "plan-a-step-4",
    });

    const [parsed] = findInvocationBlocks(rewritten);
    expect(parsed.notebookAnchor).toBe("plan-a-step-4");
    expect(parsed.submittedBy).toBe("harness");
    expect(parsed.enrichment).toBe("pending");
    // `server_verified` is not carried: it is an ordinary block field, so a
    // rewriter that means to keep it has to pass it. That is what makes the
    // record tools' `false` and the poller's upgrade land at all, and it is
    // why the annotate path reads the block before it rewrites it.
    expect(parsed.serverVerified).toBeUndefined();
  });

  it("stripHarnessFields does not mutate its input", () => {
    const input = { ...AGENT_INVOCATION, ...HARNESS };
    const stripped = stripHarnessFields(input);
    expect(input.attemptId).toBe(HARNESS.attemptId);
    expect((stripped as HarnessBlockFields).attemptId).toBeUndefined();
  });
});

describe("harness block fields: pollers preserve provenance", () => {
  it("an invocation poll update keeps the harness fields", () => {
    const recorded = upsertInvocationBlock(
      "",
      { ...AGENT_INVOCATION, serverVerified: true },
      HARNESS,
    );
    const { content } = applyInvocationUpdates(recorded, [
      {
        invocationId: AGENT_INVOCATION.invocationId,
        totalSteps: 3,
        completedSteps: 3,
        totalJobs: 3,
        completedJobs: 3,
        failedJobs: 0,
        lastPolledAt: "2026-09-16T15:35:00Z",
        transition: { status: "completed", summary: "all jobs ok" },
      },
    ]);

    const [parsed] = findInvocationBlocks(content);
    expect(parsed.status).toBe("completed");
    expect(parsed.attemptId).toBe(HARNESS.attemptId);
    expect(parsed.submittedBy).toBe("harness");
    expect(parsed.serverVerified).toBe(true);
  });

  it("a job poll update keeps the harness fields", () => {
    const recorded = upsertJobBlock("", AGENT_JOB, HARNESS);
    const content = applyJobPollUpdate(recorded, {
      jobId: AGENT_JOB.jobId,
      status: "completed",
      galaxyState: "ok",
      lastPolledAt: "2026-09-16T15:35:00Z",
    });

    const [parsed] = findJobBlocks(content);
    expect(parsed.status).toBe("completed");
    expect(parsed.attemptId).toBe(HARNESS.attemptId);
    expect(parsed.historyId).toBe(HARNESS.historyId);
  });
});

describe("harness block fields: hostile values", () => {
  function blockWith(...extra: string[]): string {
    return [
      "```loom-invocation",
      "invocation_id: ff1e2d3c4b5a6978",
      "galaxy_server_url: https://usegalaxy.org",
      "notebook_anchor: plan-a-step-3",
      "label: BWA alignment",
      "submitted_at: 2026-09-16T15:30:00Z",
      "status: in_progress",
      ...extra,
      "```",
      "",
    ].join("\n");
  }

  it("drops a submitted_by it does not recognise rather than coercing it", () => {
    const [parsed] = findInvocationBlocks(blockWith("submitted_by: definitely-the-harness"));
    expect(parsed.submittedBy).toBeUndefined();
  });

  it("reads server_verified only from the two literals", () => {
    expect(
      findInvocationBlocks(blockWith("server_verified: yes"))[0].serverVerified,
    ).toBeUndefined();
    expect(findInvocationBlocks(blockWith("server_verified: 1"))[0].serverVerified).toBeUndefined();
    expect(findInvocationBlocks(blockWith("server_verified: false"))[0].serverVerified).toBe(false);
  });

  it("survives a malformed jobs array without losing the id", () => {
    const [parsed] = findInvocationBlocks(blockWith("jobs: [{not json"));
    expect(parsed.invocationId).toBe("ff1e2d3c4b5a6978");
    expect(parsed.jobs).toBeUndefined();
  });

  it("drops jobs entries with no job_id", () => {
    const [parsed] = findInvocationBlocks(
      blockWith('jobs: [{"tool_id":"bwa_mem"},{"job_id":"job2"}]'),
    );
    expect(parsed.jobs).toEqual([{ jobId: "job2" }]);
  });

  it("keeps a colon-bearing label readable next to a JSON field", () => {
    const content = upsertJobBlock(
      "",
      { ...AGENT_JOB, label: "step 3: align reads" },
      { jobs: [{ jobId: "job1", toolId: "bwa_mem" }] },
    );
    const [parsed] = findJobBlocks(content);
    expect(parsed.label).toBe("step 3: align reads");
    expect(parsed.jobs).toEqual([{ jobId: "job1", toolId: "bwa_mem" }]);
  });
});

describe("invocation blocks round-trip without a Galaxy server url", () => {
  // Auto-registration writes a block whether or not GALAXY_URL happens to be
  // in the environment. A block its own parser rejects is worse than no block:
  // the poller never sees the run, and the notebook looks like it has a record.
  it("parses a block whose galaxy_server_url is empty", () => {
    const content = upsertInvocationBlock(
      "",
      { ...AGENT_INVOCATION, galaxyServerUrl: "" },
      HARNESS,
    );
    const [parsed] = findInvocationBlocks(content);
    expect(parsed).toBeDefined();
    expect(parsed.invocationId).toBe(AGENT_INVOCATION.invocationId);
    expect(parsed.galaxyServerUrl).toBe("");
    expect(parsed.submittedBy).toBe("harness");
  });

  it("still refuses a block with no id", () => {
    const content = [
      "```loom-invocation",
      "galaxy_server_url: https://usegalaxy.org",
      "notebook_anchor: plan-a-step-3",
      "label: BWA alignment",
      "submitted_at: 2026-09-16T15:30:00Z",
      "status: in_progress",
      "```",
    ].join("\n");
    expect(findInvocationBlocks(content)).toHaveLength(0);
  });
});

describe("harness block fields: merge helpers", () => {
  it("incoming wins per field and undefined means no change", () => {
    const merged = mergeHarnessFields(HARNESS, { enrichment: "complete" });
    expect(merged.enrichment).toBe("complete");
    expect(merged.attemptId).toBe(HARNESS.attemptId);
    expect(merged.submittedBy).toBe("harness");
  });

  it("pickHarnessFields keeps only harness keys", () => {
    expect(pickHarnessFields({ ...AGENT_INVOCATION, ...HARNESS } as HarnessBlockFields)).toEqual(
      HARNESS,
    );
  });
});

describe("harness block fields: the Orbit renderer reads the same block", () => {
  it("mirrors what the brain wrote", () => {
    const content = upsertInvocationBlock(
      "",
      { ...AGENT_INVOCATION, serverVerified: true },
      {
        ...HARNESS,
        jobs: [{ jobId: "job1", toolId: "bwa_mem", toolVersion: "0.7.17", state: "ok" }],
        drift: [{ toolId: "bwa_mem", from: "0.7.17", to: "0.7.18" }],
      },
    );

    const [row] = parseInvocationBlocks(content);
    expect(row.attemptId).toBe(HARNESS.attemptId);
    expect(row.historyId).toBe(HARNESS.historyId);
    expect(row.submittedBy).toBe("harness");
    expect(row.serverVerified).toBe(true);
    expect(row.enrichment).toBe("pending");
    expect(row.jobs).toEqual([
      { job_id: "job1", tool_id: "bwa_mem", tool_version: "0.7.17", state: "ok" },
    ]);
    expect(row.drift).toEqual([{ tool_id: "bwa_mem", from: "0.7.17", to: "0.7.18" }]);
  });

  it("drops a forged submitted_by the same way the brain does", () => {
    const content = [
      "```loom-invocation",
      "invocation_id: ff1e2d3c4b5a6978",
      "galaxy_server_url: https://usegalaxy.org",
      "notebook_anchor: plan-a-step-3",
      "label: BWA alignment",
      "submitted_at: 2026-09-16T15:30:00Z",
      "status: in_progress",
      "submitted_by: the-harness-honest",
      "```",
    ].join("\n");
    expect(parseInvocationBlocks(content)[0].submittedBy).toBeUndefined();
  });
});
