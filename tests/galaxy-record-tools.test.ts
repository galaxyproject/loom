/**
 * `galaxy_invocation_record` / `galaxy_job_record` -- the two tools that turn a
 * Galaxy id the model read out of an MCP result into a notebook block.
 *
 * They used to take everything on faith: no anchor check, no server round trip,
 * and an unguarded whole-file write. These tests pin what they now refuse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import {
  findInvocationBlocks,
  renderInvocationYaml,
  upsertInvocationBlock,
} from "../extensions/loom/notebook-writer";
import * as anchors from "../extensions/loom/notebook-anchors";
import { findJobBlocks, upsertJobBlock } from "../extensions/loom/galaxy-job-block";
import { registerPlanTools } from "../extensions/loom/tools";

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
  signal = new AbortController().signal,
): Promise<{ success: boolean; error?: string; message?: string; [k: string]: unknown }> {
  return tool
    .execute("call-1", params, signal, vi.fn(), {})
    .then((r) => JSON.parse(r.content[0].text));
}

/** Galaxy's encoded ids are hex; the verifier refuses anything else outright. */
const INV_ID = "f2db41e1fa331b3e";
const INV_ID_2 = "f597429621d6eb2b";
const JOB_ID = "bbd44e69cb8906b5";

function response(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

/**
 * Stub every Galaxy round trip. A 2xx echoes back the id in the request path,
 * which is what `verifyGalaxyRun` checks for -- a bare 200 proves nothing.
 */
function stubGalaxy(status: number, body?: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    if (body !== undefined) return response(status, body);
    const id = String(url).split("/").pop() ?? "";
    return response(status, status < 300 ? { id, state: "ok" } : "error");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const NOTEBOOK = `# Project notebook

## Plan A: chrM Variant Calling [galaxy]

### Steps

- [ ] 1. **QC FASTQs** {#plan-a-step-1} — fastp adapter trim
- [ ] 2. **Align to chrM reference** {#plan-a-step-2} — BWA-MEM
`;

describe("record tools: anchor validation", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-record-anchor-"));
    nbPath = join(dir, "notebook.md");
    writeFileSync(nbPath, NOTEBOOK, "utf-8");
    setNotebookPath(nbPath);
    // An invocation block with no galaxy_server_url doesn't parse
    // (parseInvocationBlock requires it), so every Galaxy test sets these.
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
    // Galaxy confirms every id unless a test says otherwise.
    stubGalaxy(200);
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

  it("records an invocation against an anchor that exists", async () => {
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    const blocks = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].notebookAnchor).toBe("plan-a-step-2");
  });

  it("rejects an anchor nothing in the notebook resolves to, and writes nothing", async () => {
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-1-step-3",
      label: "BWA alignment",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("plan-1-step-3");
    // The message has to name what the notebook does have, or the model has no
    // way to correct itself except by guessing again.
    expect(res.error).toContain("plan-a-step-1");
    expect(res.error).toContain("plan-a-step-2");
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });

  it("records against a derived step address when the plan has no {#anchors}", async () => {
    // The Llama-4 path: buildPlanConventionBlock({omitAnchors:true}) tells the
    // model not to write curly braces and to say "Plan A step 2" instead.
    // Refusing that would leave a real Galaxy run untracked.
    writeFileSync(
      nbPath,
      `## Plan A: chrM Variant Calling [galaxy]\n\n### Steps\n\n` +
        `- [ ] 1. **QC FASTQs** — fastp\n- [ ] 2. **Align** — BWA-MEM\n`,
      "utf-8",
    );
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "Plan A step 2",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    expect(findInvocationBlocks(readFileSync(nbPath, "utf-8"))[0].notebookAnchor).toBe(
      "plan-a-step-2",
    );
  });

  it("refuses to guess between two anchors that differ only in case", async () => {
    writeFileSync(
      nbPath,
      `## Plan A: X [galaxy]\n\n- [ ] 1. **A** {#Plan-A-Step-1}\n- [ ] 2. **B** {#PLAN-a-step-1}\n`,
      "utf-8",
    );
    const before = readFileSync(nbPath, "utf-8");
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "QC",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("Ambiguous");
    expect(readFileSync(nbPath, "utf-8")).toBe(before);
  });

  it("accepts a plan heading's slug", async () => {
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-chrm-variant-calling-galaxy",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    expect(findInvocationBlocks(readFileSync(nbPath, "utf-8"))[0].notebookAnchor).toBe(
      "plan-a-chrm-variant-calling-galaxy",
    );
  });

  it("stores the notebook's spelling of the anchor, not the caller's", async () => {
    const { invocation } = recordTools();
    await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "{#PLAN-A-STEP-1}",
      label: "QC",
    });

    expect(findInvocationBlocks(readFileSync(nbPath, "utf-8"))[0].notebookAnchor).toBe(
      "plan-a-step-1",
    );
  });

  it("records a job against an anchor that exists", async () => {
    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
      toolId: "fastqc",
    });

    expect(res.success).toBe(true);
    const blocks = findJobBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].notebookAnchor).toBe("plan-a-step-1");
  });

  it("rejects a job whose anchor does not resolve, and writes nothing", async () => {
    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "step-99",
      label: "FastQC",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("step-99");
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });

  it("does not let a previously recorded block validate the next record call", async () => {
    // The blocks are fences carrying their own notebook_anchor: line. Reading
    // those as anchors would make the check confirm its own writes.
    const { invocation } = recordTools();
    await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "QC",
    });
    const res = await run(invocation, {
      invocationId: INV_ID_2,
      notebookAnchor: "plan-a-step-1-typo",
      label: "QC again",
    });

    expect(res.success).toBe(false);
    expect(findInvocationBlocks(readFileSync(nbPath, "utf-8"))).toHaveLength(1);
  });
});

describe("record tools: server verification", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-record-verify-"));
    nbPath = join(dir, "notebook.md");
    writeFileSync(nbPath, NOTEBOOK, "utf-8");
    setNotebookPath(nbPath);
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
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

  it("refuses an invocation id Galaxy has never heard of, and writes nothing", async () => {
    stubGalaxy(404, "No invocation found");
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "BWA alignment",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain(INV_ID);
    expect(res.error).toContain("404");
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });

  it("refuses a malformed job id (Galaxy answers 400), and writes nothing", async () => {
    stubGalaxy(400, "Malformed id");
    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain(JOB_ID);
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });

  it("refuses an id that cannot be a Galaxy id, without calling Galaxy", async () => {
    const fetchMock = stubGalaxy(200);
    const { job } = recordTools();
    const res = await run(job, {
      jobId: "../histories",
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
    });

    expect(res.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });

  it("marks a confirmed invocation server_verified: true", async () => {
    stubGalaxy(200);
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    expect(res.serverVerified).toBe(true);
    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).toContain("server_verified: true");
    expect(findInvocationBlocks(notebook)[0].serverVerified).toBe(true);
  });

  it("records an invocation Galaxy could not answer for, marked unverified", async () => {
    // A 502 says nothing about the id. Losing a real submission to a transient
    // network is worse than a line the poller will confirm on its next tick.
    stubGalaxy(502, "bad gateway");
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    expect(res.serverVerified).toBe(false);
    expect(res.message).toContain("could not confirm");
    expect(res.message).toContain("502");
    const blocks = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks[0].serverVerified).toBe(false);
  });

  it("records a job Galaxy could not answer for, marked unverified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
    });

    expect(res.success).toBe(true);
    expect(res.serverVerified).toBe(false);
    const blocks = findJobBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks[0].serverVerified).toBe(false);
    expect(blocks[0].status).toBe("in_progress");
  });

  it("does not record an unverified block for a call the user cancelled", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new Error("The operation was aborted");
      }),
    );
    const { invocation } = recordTools();
    const res = await run(
      invocation,
      { invocationId: INV_ID, notebookAnchor: "plan-a-step-1", label: "BWA" },
      controller.signal,
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("Cancelled");
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });

  it("still rejects a bad anchor when Galaxy confirms the id", async () => {
    stubGalaxy(200);
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "not-a-step",
      label: "BWA",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("not-a-step");
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });
});

describe("record tools: compare-and-swap write", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-record-cas-"));
    nbPath = join(dir, "notebook.md");
    writeFileSync(nbPath, NOTEBOOK, "utf-8");
    setNotebookPath(nbPath);
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
    stubGalaxy(200);
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

  /**
   * Land `write` on disk from inside the record tool's read-modify-write
   * window, `times` times.
   *
   * Anchor resolution is the one step of that window the test can reach: it
   * runs against the content the tool just read and before the write goes out,
   * which is exactly where a competing writer does its damage. Real resolution
   * still happens -- the spy only sneaks a file write in first.
   */
  function writeDuringRecord(write: () => void, times = 1): void {
    const real = anchors.resolveNotebookAnchor;
    let seen = 0;
    vi.spyOn(anchors, "resolveNotebookAnchor").mockImplementation((content, input) => {
      if (seen++ < times) write();
      return real(content, input);
    });
  }

  it("keeps a poll update that lands between the record's read and its write", async () => {
    // The poller writes under its own compare-and-swap, but that can't defend
    // against an unguarded whole-file write from this side: the record tool
    // used to render the file from content captured before the poll existed.
    const polled = (status: string) =>
      renderInvocationYaml({
        invocationId: INV_ID,
        galaxyServerUrl: "https://usegalaxy.org",
        notebookAnchor: "plan-a-step-1",
        label: "Earlier run",
        submittedAt: "2026-09-16T00:00:00Z",
        status: status as "in_progress" | "completed" | "failed",
      });
    writeFileSync(nbPath, `${NOTEBOOK}\n${polled("in_progress")}`, "utf-8");
    writeDuringRecord(() => writeFileSync(nbPath, `${NOTEBOOK}\n${polled("completed")}`, "utf-8"));

    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID_2,
      notebookAnchor: "plan-a-step-2",
      label: "Second run",
    });

    expect(res.success).toBe(true);
    const blocks = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks).toHaveLength(2);
    // The poll's transition survived...
    expect(blocks.find((b) => b.invocationId === INV_ID)?.status).toBe("completed");
    // ...and so did our new block.
    expect(blocks.find((b) => b.invocationId === INV_ID_2)?.label).toBe("Second run");
  });

  it("keeps a concurrent write when recording a job", async () => {
    writeDuringRecord(() =>
      appendFileSync(nbPath, "\n### Results\n\nCD4 up, CD8 flat.\n", "utf-8"),
    );

    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
    });

    expect(res.success).toBe(true);
    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).toContain("CD4 up, CD8 flat.");
    expect(findJobBlocks(notebook)).toHaveLength(1);
  });

  it("gives up rather than clobbering when the notebook never settles", async () => {
    // A writer that lands on every attempt. Refusing is the right answer: the
    // alternative is overwriting whatever it wrote.
    writeDuringRecord(() => appendFileSync(nbPath, "\nstill moving\n", "utf-8"), 10);

    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "BWA",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("changed on disk");
    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).not.toContain(`invocation_id: ${INV_ID}`);
    expect(notebook).toContain("still moving");
  });
});

describe("record tools: annotate what the harness already recorded", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  const HARNESS = {
    attemptId: "01K5CJ6XWQ8QK4S2M7E9V0TZ3B",
    historyId: "0a248a1f62a0cc04",
    submittedBy: "harness" as const,
    enrichment: "pending" as const,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-record-annotate-"));
    nbPath = join(dir, "notebook.md");
    writeFileSync(nbPath, NOTEBOOK, "utf-8");
    setNotebookPath(nbPath);
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
    stubGalaxy(200);
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

  /** A block as the capture hook writes it: harness provenance, mid-flight. */
  function harnessRecorded(): void {
    const block = upsertInvocationBlock(
      "",
      {
        invocationId: INV_ID,
        galaxyServerUrl: "https://usegalaxy.org",
        notebookAnchor: "unattributed",
        label: "galaxy_invoke_workflow",
        submittedAt: "2026-09-16T15:30:00Z",
        status: "in_progress",
        serverVerified: true,
        totalSteps: 4,
        completedSteps: 2,
        totalJobs: 9,
        completedJobs: 5,
        failedJobs: 0,
        lastPolledAt: "2026-09-16T15:34:00Z",
      },
      HARNESS,
    );
    appendFileSync(nbPath, "\n" + block, "utf-8");
  }

  it("sets only label and anchor on an invocation block that already exists", async () => {
    harnessRecorded();
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    expect(res.annotated).toBe(true);
    expect(String(res.message)).toContain("already recorded");

    const blocks = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.notebookAnchor).toBe("plan-a-step-2");
    expect(block.label).toBe("BWA alignment");
    // Everything the harness and the poller own is untouched. A fresh record
    // object here would have reset a running invocation to zero progress.
    expect(block.submittedAt).toBe("2026-09-16T15:30:00Z");
    expect(block.completedSteps).toBe(2);
    expect(block.completedJobs).toBe(5);
    expect(block.lastPolledAt).toBe("2026-09-16T15:34:00Z");
    expect(block.serverVerified).toBe(true);
    expect(block.attemptId).toBe(HARNESS.attemptId);
    expect(block.submittedBy).toBe("harness");
  });

  it("annotates a job block without overwriting its recorded tool id", async () => {
    const block = upsertJobBlock(
      "",
      {
        jobId: JOB_ID,
        galaxyServerUrl: "https://usegalaxy.org",
        notebookAnchor: "unattributed",
        label: "galaxy_run_tool",
        toolId: "bwa_mem",
        submittedAt: "2026-09-16T15:30:00Z",
        status: "in_progress",
        serverVerified: true,
      },
      HARNESS,
    );
    appendFileSync(nbPath, "\n" + block, "utf-8");

    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
      toolId: "not_the_recorded_tool",
    });

    expect(res.success).toBe(true);
    expect(res.annotated).toBe(true);
    const [parsed] = findJobBlocks(readFileSync(nbPath, "utf-8"));
    expect(parsed.notebookAnchor).toBe("plan-a-step-1");
    expect(parsed.label).toBe("FastQC");
    expect(parsed.toolId).toBe("bwa_mem");
    expect(parsed.serverVerified).toBe(true);
    expect(parsed.attemptId).toBe(HARNESS.attemptId);
  });

  it("creates the block when nothing carries the id, attributed to the agent", async () => {
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    expect(res.annotated).toBe(false);
    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).toContain("submitted_by: agent");
    const [block] = findInvocationBlocks(notebook);
    expect(block.submittedBy).toBe("agent");
    expect(block.serverVerified).toBe(true);
    expect(block.attemptId).toBeUndefined();
  });

  it("creates a job block attributed to the agent too", async () => {
    const { job } = recordTools();
    const res = await run(job, {
      jobId: JOB_ID,
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
      toolId: "fastqc",
    });

    expect(res.success).toBe(true);
    expect(res.annotated).toBe(false);
    const [parsed] = findJobBlocks(readFileSync(nbPath, "utf-8"));
    expect(parsed.submittedBy).toBe("agent");
    expect(parsed.toolId).toBe("fastqc");
  });

  it("does not turn an agent-created block into a harness one on re-annotate", async () => {
    const { invocation } = recordTools();
    await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-1",
      label: "first pass",
    });
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "second pass",
    });

    expect(res.annotated).toBe(true);
    const [block] = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(block.notebookAnchor).toBe("plan-a-step-2");
    expect(block.submittedBy).toBe("agent");
  });

  it("still refuses an anchor nothing resolves to, leaving the block bound as it was", async () => {
    harnessRecorded();
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-1-step-3",
      label: "BWA alignment",
    });

    expect(res.success).toBe(false);
    const [block] = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(block.notebookAnchor).toBe("unattributed");
    expect(block.label).toBe("galaxy_invoke_workflow");
  });

  it("still refuses an id Galaxy denies, even with a block already carrying it", async () => {
    harnessRecorded();
    stubGalaxy(404);
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "BWA alignment",
    });

    expect(res.success).toBe(false);
    const [block] = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(block.notebookAnchor).toBe("unattributed");
  });

  it("leaves an unconfirmed block unconfirmed rather than certifying it itself", async () => {
    // The poller owns the upgrade, because only it checks that the server that
    // answered is the server the block names. A record call asks whatever
    // server is configured now, which is not the same question.
    const block = upsertInvocationBlock("", {
      invocationId: INV_ID,
      galaxyServerUrl: "https://other.galaxy.test",
      notebookAnchor: "unattributed",
      label: "galaxy_invoke_workflow",
      submittedAt: "2026-09-16T15:30:00Z",
      status: "in_progress",
      serverVerified: false,
    });
    appendFileSync(nbPath, "\n" + block, "utf-8");

    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: INV_ID,
      notebookAnchor: "plan-a-step-2",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    const [parsed] = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(parsed.notebookAnchor).toBe("plan-a-step-2");
    expect(parsed.serverVerified).toBe(false);
    expect(parsed.galaxyServerUrl).toBe("https://other.galaxy.test");
  });
});
