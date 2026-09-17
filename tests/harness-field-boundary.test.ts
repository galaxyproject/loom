/**
 * Where #465's harness-only fields stop and #462's `server_verified` starts.
 *
 * Two branches wrote provenance onto the same two blocks. #465 gave the blocks
 * `attempt_id`, `history_id`, `submitted_by` and the enrichment fields, and
 * made both upsert functions strip them off whatever a caller hands over so
 * the agent cannot assert provenance it didn't earn. #462 gave them a
 * tri-state `server_verified` that the record tools write and the poller
 * upgrades.
 *
 * Those two rules pull in opposite directions on one field, so this pins the
 * line between them: `server_verified` is an ordinary block field that a
 * record tool and a poll can both write, and everything in the harness set
 * stays unwritable from a tool call no matter what it is handed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import {
  applyInvocationUpdates,
  findInvocationBlocks,
  upsertInvocationBlock,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";
import {
  applyJobPollUpdate,
  findJobBlocks,
  upsertJobBlock,
  type JobYaml,
} from "../extensions/loom/galaxy-job-block";
import { registerPlanTools } from "../extensions/loom/tools";
import type { HarnessBlockFields } from "../extensions/loom/harness-block-fields";

const INV_ID = "f2db41e1fa331b3e";
const JOB_ID = "bbd44e69cb8906b5";
const ATTEMPT = "01K5CJ6XWQ8QK4S2M7E9V0TZ3B";

const HARNESS: HarnessBlockFields = {
  attemptId: ATTEMPT,
  historyId: "0a248a1f62a0cc04",
  submittedBy: "harness",
  enrichment: "pending",
  enrichmentAttempts: 0,
};

const INVOCATION: InvocationYaml = {
  invocationId: INV_ID,
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-1",
  label: "BWA alignment",
  submittedAt: "2026-09-16T15:30:00Z",
  status: "in_progress",
};

const JOB: JobYaml = {
  jobId: JOB_ID,
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-1",
  label: "BWA alignment",
  submittedAt: "2026-09-16T15:30:00Z",
  status: "in_progress",
};

describe("a poll upgrade lands on a block the harness wrote", () => {
  // The hazard the strip introduces: if `server_verified` were in the harness
  // set, the upsert would drop the poller's `true` and read the block's own
  // `false` back off disk, so an unconfirmed run would stay unconfirmed for
  // ever while looking like it was being polled.
  it("clears server_verified: false on an invocation carrying harness provenance", () => {
    const content = upsertInvocationBlock("", { ...INVOCATION, serverVerified: false }, HARNESS);
    expect(content).toContain("server_verified: false");

    const { content: next } = applyInvocationUpdates(content, [
      {
        invocationId: INV_ID,
        totalSteps: 3,
        completedSteps: 1,
        totalJobs: 3,
        completedJobs: 1,
        failedJobs: 0,
        lastPolledAt: "2026-09-16T15:35:00Z",
        serverVerified: true,
      },
    ]);

    const [parsed] = findInvocationBlocks(next);
    expect(parsed.serverVerified).toBe(true);
    // and the provenance it was written with is still there
    expect(parsed.attemptId).toBe(ATTEMPT);
    expect(parsed.submittedBy).toBe("harness");
  });

  it("clears server_verified: false on a job carrying harness provenance", () => {
    const content = upsertJobBlock("", { ...JOB, serverVerified: false }, HARNESS);
    expect(content).toContain("server_verified: false");

    const next = applyJobPollUpdate(content, {
      jobId: JOB_ID,
      lastPolledAt: "2026-09-16T15:35:00Z",
      serverVerified: true,
    });

    const [parsed] = findJobBlocks(next);
    expect(parsed.serverVerified).toBe(true);
    expect(parsed.attemptId).toBe(ATTEMPT);
    expect(parsed.submittedBy).toBe("harness");
  });

  it("still leaves a block that never carried the flag unstamped", () => {
    const content = upsertJobBlock("", JOB, HARNESS);
    const next = applyJobPollUpdate(content, {
      jobId: JOB_ID,
      lastPolledAt: "2026-09-16T15:35:00Z",
      serverVerified: true,
    });
    expect(next).not.toContain("server_verified");
    expect(findJobBlocks(next)[0].serverVerified).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The other half: a record tool still cannot write the harness set.
// ─────────────────────────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
}

function recordTools(): { invocation: ToolDef; job: ToolDef } {
  const tools: ToolDef[] = [];
  const api = { registerTool: (def: ToolDef) => tools.push(def) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPlanTools(api as any);
  const invocation = tools.find((t) => t.name === "galaxy_invocation_record");
  const job = tools.find((t) => t.name === "galaxy_job_record");
  if (!invocation || !job) throw new Error("record tools not registered");
  return { invocation, job };
}

function run(
  tool: ToolDef,
  params: Record<string, unknown>,
): Promise<{ success: boolean; [k: string]: unknown }> {
  return tool
    .execute("call-1", params, new AbortController().signal, vi.fn(), {})
    .then((r) => JSON.parse(r.content[0].text));
}

const NOTEBOOK = `# Project notebook

## Plan A: chrM Variant Calling [galaxy]

### Steps

- [ ] 1. **QC FASTQs** {#plan-a-step-1} — fastp adapter trim
- [ ] 2. **Align to chrM reference** {#plan-a-step-2} — BWA-MEM
`;

describe("a record tool cannot write the harness set", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-harness-boundary-"));
    nbPath = join(dir, "notebook.md");
    setNotebookPath(nbPath);
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
    // Galaxy confirms whatever it is asked about, echoing the id back.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const id = String(url).split("/").pop() ?? "";
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id, state: "ok" }),
          json: async () => ({ id, state: "ok" }),
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    resetState();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the harness's attribution alone when it rewrites an invocation block", async () => {
    writeFileSync(
      nbPath,
      NOTEBOOK + "\n" + upsertInvocationBlock("", { ...INVOCATION, serverVerified: true }, HARNESS),
      "utf-8",
    );

    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "relabelled by the agent",
      // What an agent spreading its own arguments into the record would send.
      attemptId: "01FORGEDFORGEDFORGEDFORGED",
      submittedBy: "harness",
      historyId: "deadbeefdeadbeef",
      enrichment: "complete",
    });
    expect(res.success).toBe(true);

    const notebook = readFileSync(nbPath, "utf-8");
    const [parsed] = findInvocationBlocks(notebook);
    expect(parsed.notebookAnchor).toBe("plan-a-step-2");
    expect(parsed.label).toBe("relabelled by the agent");
    expect(parsed.attemptId).toBe(ATTEMPT);
    expect(parsed.historyId).toBe(HARNESS.historyId);
    expect(parsed.enrichment).toBe("pending");
    expect(notebook).not.toContain("01FORGEDFORGEDFORGEDFORGED");
    expect(notebook).not.toContain("deadbeefdeadbeef");
  });

  it("leaves the harness's attribution alone when it rewrites a job block", async () => {
    writeFileSync(
      nbPath,
      NOTEBOOK + "\n" + upsertJobBlock("", { ...JOB, serverVerified: true }, HARNESS),
      "utf-8",
    );

    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "plan-a-step-2",
      label: "relabelled by the agent",
      attemptId: "01FORGEDFORGEDFORGEDFORGED",
      submittedBy: "harness",
    });
    expect(res.success).toBe(true);

    const notebook = readFileSync(nbPath, "utf-8");
    const [parsed] = findJobBlocks(notebook);
    expect(parsed.notebookAnchor).toBe("plan-a-step-2");
    expect(parsed.attemptId).toBe(ATTEMPT);
    expect(notebook).not.toContain("01FORGEDFORGEDFORGEDFORGED");
  });

  it("cannot smuggle submitted_by through a multiline label", async () => {
    writeFileSync(nbPath, NOTEBOOK, "utf-8");

    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "BWA\nsubmitted_by: harness\nattempt_id: 01FORGEDFORGEDFORGEDFORGED",
    });
    expect(res.success).toBe(true);

    const notebook = readFileSync(nbPath, "utf-8");
    const [parsed] = findInvocationBlocks(notebook);
    expect(parsed.submittedBy).toBe("agent");
    expect(parsed.attemptId).toBeUndefined();
    expect(notebook).not.toMatch(/^attempt_id:/m);
  });

  it("refuses a multiline tool id instead of writing half a job block", async () => {
    writeFileSync(nbPath, NOTEBOOK, "utf-8");

    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
      toolId: "fastqc\nsubmitted_by: harness",
    });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("toolId");
    const notebook = readFileSync(nbPath, "utf-8");
    expect(findJobBlocks(notebook)).toHaveLength(0);
    expect(notebook).not.toContain("submitted_by");
  });

  it("survives two annotate calls where the first one empties the label", async () => {
    // The strict parser requires a label, the range finder does not, so a
    // block annotated with an empty label used to vanish from one lookup and
    // not the other -- and the next call rewrote it as a fresh agent record,
    // taking attempt_id, history_id and enrichment with it. The label is
    // refused now, and carry-forward reads the physical block either way.
    writeFileSync(
      nbPath,
      NOTEBOOK + "\n" + upsertInvocationBlock("", { ...INVOCATION, serverVerified: true }, HARNESS),
      "utf-8",
    );

    const { invocation } = recordTools();
    const first = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "   ",
    });
    expect(first.success).toBe(false);
    expect(String(first.error)).toContain("label");

    const second = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "restored",
    });
    expect(second.success).toBe(true);
    expect(second.annotated).toBe(true);

    const [parsed] = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(parsed.notebookAnchor).toBe("plan-a-step-2");
    expect(parsed.submittedBy).toBe("harness");
    expect(parsed.attemptId).toBe(ATTEMPT);
    expect(parsed.historyId).toBe(HARNESS.historyId);
    expect(parsed.enrichment).toBe("pending");
  });

  it("refuses to rewrite a block it cannot read rather than re-attributing it", async () => {
    // Same disagreement from the other side: a hand-mangled block the range
    // finder still matches. Overwriting it would file a harness-recorded run
    // as an agent one.
    const mangled = upsertInvocationBlock("", { ...INVOCATION, serverVerified: true }, HARNESS)
      .split("\n")
      .filter((line) => !line.startsWith("label:"))
      .join("\n");
    writeFileSync(nbPath, NOTEBOOK + "\n" + mangled, "utf-8");

    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "BWA alignment",
    });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("cannot be read");
    const after = readFileSync(nbPath, "utf-8");
    expect(after).toContain("submitted_by: harness");
    expect(after).toContain(`attempt_id: ${ATTEMPT}`);
  });

  it("carries provenance from the block it replaces, not from a namesake", () => {
    // Two blocks share an id: one the range finder matches first but the
    // strict parser rejects, one it accepts. A second scan for the
    // carry-forward reads the wrong one and copies its provenance across.
    const malformed = upsertInvocationBlock("", { ...INVOCATION, serverVerified: true }, HARNESS)
      .split("\n")
      .filter((line) => !line.startsWith("label:"))
      .join("\n");
    const other = upsertInvocationBlock(
      "",
      { ...INVOCATION, label: "second", serverVerified: true },
      { ...HARNESS, attemptId: "01OTHEROTHEROTHEROTHEROTHE", historyId: "ffffffffffffffff" },
    );

    const next = upsertInvocationBlock(`${malformed}\n${other}`, {
      ...INVOCATION,
      label: "annotated",
    });

    // The first block is the one rewritten, so it keeps its own attempt id.
    expect(next).toContain(`attempt_id: ${ATTEMPT}`);
    expect(next.indexOf("01OTHEROTHEROTHEROTHEROTHE")).toBeGreaterThan(next.indexOf(ATTEMPT));
  });

  it("cannot claim submitted_by: harness on a block the harness never wrote", async () => {
    writeFileSync(nbPath, NOTEBOOK, "utf-8");

    const { invocation } = recordTools();
    await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "BWA alignment",
      attemptId: "01FORGEDFORGEDFORGEDFORGED",
      submittedBy: "harness",
    });

    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).not.toContain("submitted_by: harness");
    expect(notebook).not.toContain("attempt_id");
    expect(findInvocationBlocks(notebook)[0].submittedBy).not.toBe("harness");
  });
});
