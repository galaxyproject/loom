import { describe, expect, it } from "vitest";
import { format } from "prettier";

import { applyJobPollUpdate, findJobBlocks } from "../extensions/loom/galaxy-job-block";
import { applyJobOutcome } from "../browser/core/src/agent/record-jobs";

// Both shells advance the record when a Galaxy job settles, from different data
// models: loom rewrites its loom-job block, the browser stamps the line carrying
// the job id and ticks the step. One record holding both shapes, run through
// each for a completed and a failed job, pins where they disagree (#567 2.2).
const FIXTURE = `## Plan A: chrM Variant Calling [remote]

- [ ] 1. **Align to chrM reference** -- BWA-MEM, sorted BAM out
  - Routing: galaxy
  - Galaxy job \`abc123\` — submitted, awaiting completion

\`\`\`loom-job
job_id: abc123
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-1
label: BWA alignment
tool_id: bwa_mem
submitted_at: 2026-10-11T12:00:00Z
status: in_progress
summary: ""
\`\`\`

*Submitted jobs are currently running.*
`;

const OUTCOMES = {
  completed: { status: "completed", state: "ok" },
  failed: { status: "failed", state: "error" },
} as const;

const lines = (text: string) => text.split("\n");

describe("a settled job, as each shell records it", () => {
  it("starts from a record both shells can read", () => {
    expect(findJobBlocks(FIXTURE)).toEqual([
      expect.objectContaining({ jobId: "abc123", status: "in_progress" }),
    ]);
  });

  it("pins loom's and the browser's record for a completed and a failed job", async () => {
    const report = Object.fromEntries(
      Object.entries(OUTCOMES).map(([outcome, { status, state }]) => [
        outcome,
        {
          loom: lines(
            applyJobPollUpdate(FIXTURE, {
              jobId: "abc123",
              status,
              galaxyState: state,
              lastPolledAt: "2026-10-11T12:30:00Z",
            }),
          ),
          browser: lines(
            applyJobOutcome(FIXTURE, { id: "abc123", kind: "job", state, outcome: status }),
          ),
        },
      ]),
    );
    const json = await format(JSON.stringify({ fixture: lines(FIXTURE), ...report }, null, 2), {
      parser: "json",
      printWidth: 100,
    });
    await expect(json).toMatchFileSnapshot("__surface__/record-outcome-parity.json");
  });
});
