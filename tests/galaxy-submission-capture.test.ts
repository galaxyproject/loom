import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import {
  handleSubmissionResult,
  registerSubmissionCapture,
  resetSubmissionCapture,
  safeProvenanceFilename,
  UDT_PROVENANCE_DIR,
} from "../extensions/loom/galaxy-submission-capture";
import { findInvocationBlocks } from "../extensions/loom/notebook-writer";
import { findJobBlocks } from "../extensions/loom/galaxy-job-block";
import { findUdtBlocks } from "../extensions/loom/galaxy-udt-block";
import { resetState, setCurrentStepAnchor, setNotebookPath } from "../extensions/loom/state";
import { isUlid } from "../extensions/loom/ulid";

let tmpDir: string;
let nbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-capture-"));
  nbPath = path.join(tmpDir, "notebook.md");
  fs.writeFileSync(nbPath, "# Analysis\n", "utf-8");
  resetState();
  resetSubmissionCapture();
  setNotebookPath(nbPath);
  process.env.GALAXY_URL = "https://usegalaxy.org";
  process.env.GALAXY_API_KEY = "test-key";
});

afterEach(() => {
  resetState();
  resetSubmissionCapture();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.GALAXY_URL;
  delete process.env.GALAXY_API_KEY;
});

function mcpResult(envelope: unknown, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    details: { server: "galaxy", ...details },
  };
}

function notebook(): string {
  return fs.readFileSync(nbPath, "utf-8");
}

function activity(): { kind: string; source: string; payload: Record<string, unknown> }[] {
  const file = path.join(tmpDir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const INVOCATION = {
  data: {
    id: "ff1e2d3c4b5a6978",
    model_class: "WorkflowInvocation",
    workflow_id: "c0ffee1234567890",
    history_id: "0a248a1f62a0cc04",
    state: "new",
  },
  success: true,
  message: "Invoked workflow 'c0ffee1234567890'",
};

const THREE_JOBS = {
  data: {
    outputs: [],
    jobs: [
      { id: "job000000000001", state: "new", tool_id: "fastp", tool_version: "0.23.4" },
      { id: "job000000000002", state: "new", tool_id: "fastp", tool_version: "0.23.4" },
      { id: "job000000000003", state: "new", tool_id: "fastp", tool_version: "0.23.4" },
    ],
    implicit_collections: [{ id: "hdca00000000001", output_name: "out1" }],
  },
  success: true,
  message: "Started tool 'fastp' in history '0a248a1f62a0cc04'",
};

const UDT = {
  data: {
    id: "f2ce1234abcd5678",
    uuid: "8d5f1c2e-9a0b-4c3d-8e7f-1a2b3c4d5e6f",
    active: true,
    tool_id: "clean_table",
    representation: {
      class: "GalaxyUserTool",
      id: "clean_table",
      version: "0.1.0",
      name: "Clean Table",
      container: "quay.io/biocontainers/pandas:1.5.2",
      shell_command: "python3 clean.py",
    },
  },
  success: true,
  message: "Created user-defined tool 'Clean Table'",
};

/** Run a submission through the dispatch path the real hook uses. */
async function submit(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  isError = false,
) {
  const starts: ((event: any, ctx: any) => Promise<unknown>)[] = [];
  const ends: ((event: any, ctx: any) => Promise<unknown>)[] = [];
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => Promise<unknown>) => {
      if (event === "tool_execution_start") starts.push(handler);
      if (event === "tool_execution_end") ends.push(handler);
    },
  };
  registerSubmissionCapture(pi as any);

  const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
  for (const h of starts) await h({ type: "tool_execution_start", toolCallId, toolName, args }, {});
  for (const h of ends) {
    await h({ type: "tool_execution_end", toolCallId, toolName, result, isError }, {});
  }
}

describe("submission capture: registration", () => {
  it("writes an invocation block the moment a workflow is invoked", async () => {
    setCurrentStepAnchor("plan-a-step-3");
    await submit(
      "galaxy_invoke_workflow",
      { workflow_id: "c0ffee1234567890" },
      mcpResult(INVOCATION),
    );

    const [block] = findInvocationBlocks(notebook());
    expect(block.invocationId).toBe("ff1e2d3c4b5a6978");
    expect(block.status).toBe("in_progress");
    expect(block.notebookAnchor).toBe("plan-a-step-3");
    expect(block.historyId).toBe("0a248a1f62a0cc04");
    expect(block.submittedBy).toBe("harness");
    expect(block.serverVerified).toBe(true);
    expect(block.enrichment).toBe("pending");
    expect(block.galaxyServerUrl).toBe("https://usegalaxy.org");
    expect(isUlid(block.attemptId!)).toBe(true);

    const rows = activity().filter((r) => r.kind === "submission.registered");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("submission-capture");
    expect(rows[0].payload.invocation_id).toBe("ff1e2d3c4b5a6978");
    expect(rows[0].payload.step_anchor).toBe("plan-a-step-3");
    expect(rows[0].payload.attempt_id).toBe(block.attemptId);
  });

  it("writes one job block per job for a mapped-over run, sharing the attempt", async () => {
    await submit("galaxy_run_tool", { tool_id: "fastp" }, mcpResult(THREE_JOBS));

    const blocks = findJobBlocks(notebook());
    expect(blocks.map((b) => b.jobId)).toEqual([
      "job000000000001",
      "job000000000002",
      "job000000000003",
    ]);
    expect(new Set(blocks.map((b) => b.attemptId)).size).toBe(1);
    for (const block of blocks) {
      expect(block.submittedBy).toBe("harness");
      expect(block.toolId).toBe("fastp");
      // tool_version only exists in the submission response, so it is captured
      // here or not at all.
      expect(block.jobs?.[0].toolVersion).toBe("0.23.4");
    }

    const [row] = activity().filter((r) => r.kind === "submission.registered");
    expect(row.payload.job_ids).toEqual(["job000000000001", "job000000000002", "job000000000003"]);
  });

  it("marks work with no plan step as unattributed rather than guessing", async () => {
    await submit("galaxy_run_tool", { tool_id: "fastp" }, mcpResult(THREE_JOBS));
    expect(findJobBlocks(notebook())[0].notebookAnchor).toBe("unattributed");
  });

  it("registers an upload from Loom's own uploader", async () => {
    await submit(
      "galaxy_upload_local_file",
      { path: "/data/reads/sample.fastq.gz" },
      {
        content: [{ type: "text", text: JSON.stringify({ uploaded: true }) }],
        details: { historyId: "0a248a1f62a0cc04", datasetId: "ds1", jobs: ["upjob00000000002"] },
      },
    );

    const [block] = findJobBlocks(notebook());
    expect(block.jobId).toBe("upjob00000000002");
    expect(block.label).toBe("Upload sample.fastq.gz");
    expect(block.historyId).toBe("0a248a1f62a0cc04");
    expect(block.submittedBy).toBe("harness");
  });
});

describe("submission capture: refusing to guess", () => {
  it("logs submission.unparsed and writes no block", async () => {
    const before = notebook();
    await submit(
      "galaxy_run_tool",
      { tool_id: "fastp" },
      {
        content: [{ type: "text", text: "Started your tool, job id is probably 1a2b3c4d5e6f7a8b" }],
      },
    );

    expect(notebook()).toBe(before);
    expect(findJobBlocks(notebook())).toHaveLength(0);

    const rows = activity().filter((r) => r.kind === "submission.unparsed");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.tool).toBe("galaxy_run_tool");
    expect(typeof rows[0].payload.reason).toBe("string");
    expect(activity().filter((r) => r.kind === "submission.registered")).toHaveLength(0);
  });

  it("records nothing at all when the submission itself failed", async () => {
    const before = notebook();
    await submit(
      "galaxy_run_tool",
      { tool_id: "fastp" },
      { content: [{ type: "text", text: "Error calling tool 'run_tool': no such history" }] },
      true,
    );

    expect(notebook()).toBe(before);
    expect(activity().filter((r) => r.kind.startsWith("submission."))).toHaveLength(0);
  });

  it("ignores tools that are not submissions", async () => {
    const before = notebook();
    await submit("galaxy_get_history_contents", {}, mcpResult(THREE_JOBS));
    expect(notebook()).toBe(before);
    expect(activity().filter((r) => r.kind.startsWith("submission."))).toHaveLength(0);
  });
});

describe("submission capture: writing alongside other writers", () => {
  it("does not overwrite an edit that lands while the block is being built", async () => {
    // The notebook lock only serialises writers inside this process. The
    // agent's own edit/write tools, an editor, and a second Loom process are
    // all outside it, so the write is a compare-and-swap that rebuilds on the
    // current bytes instead of renaming stale content over someone's edit.
    const marker = "## Notes added while the tool was running";

    // Fires during capture's stat/read awaits, i.e. after it has read and
    // before it writes.
    const competing = setTimeout(() => {
      fs.appendFileSync(nbPath, `\n${marker}\n`, "utf-8");
    }, 0);

    await submit("galaxy_run_tool", { tool_id: "fastp" }, mcpResult(THREE_JOBS));
    clearTimeout(competing);

    const after = notebook();
    expect(after).toContain(marker);
    expect(findJobBlocks(after).map((b) => b.jobId)).toEqual([
      "job000000000001",
      "job000000000002",
      "job000000000003",
    ]);
  });
});

describe("submission capture: attribution is captured at dispatch", () => {
  it("binds to the step that was current when the tool started, not when it answered", async () => {
    // The shape this exists for: a slow submission answers after the agent has
    // moved on. Reading the anchor at result time would file the run under the
    // wrong step.
    const starts: ((event: any, ctx: any) => Promise<unknown>)[] = [];
    const ends: ((event: any, ctx: any) => Promise<unknown>)[] = [];
    registerSubmissionCapture({
      on: (event: string, handler: (event: any, ctx: any) => Promise<unknown>) => {
        if (event === "tool_execution_start") starts.push(handler);
        if (event === "tool_execution_end") ends.push(handler);
      },
    } as any);

    setCurrentStepAnchor("plan-a-step-3");
    await starts[0](
      {
        type: "tool_execution_start",
        toolCallId: "slow-call",
        toolName: "galaxy_invoke_workflow",
        args: { workflow_id: "c0ffee1234567890" },
      },
      {},
    );

    setCurrentStepAnchor("plan-a-step-9");

    await ends[0](
      {
        type: "tool_execution_end",
        toolCallId: "slow-call",
        toolName: "galaxy_invoke_workflow",
        result: mcpResult(INVOCATION),
        isError: false,
      },
      {},
    );

    expect(findInvocationBlocks(notebook())[0].notebookAnchor).toBe("plan-a-step-3");
  });

  it("stays unattributed when the start event was never seen", async () => {
    // No dispatch record means we do not know what this belonged to. Falling
    // back to the current anchor here would be the exact bug above.
    setCurrentStepAnchor("plan-a-step-9");
    await handleSubmissionResult(
      "orphan-call",
      "galaxy_invoke_workflow",
      mcpResult(INVOCATION),
      false,
    );
    expect(findInvocationBlocks(notebook())[0].notebookAnchor).toBe("unattributed");
  });
});

describe("submission capture: user-defined tools", () => {
  it("preserves the definition Galaxy stored and points a block at it", async () => {
    setCurrentStepAnchor("plan-a-step-2");
    await submit(
      "galaxy_create_user_tool",
      { representation: { id: "clean_table" } },
      mcpResult(UDT),
    );

    // Named by tool id AND uuid: the uuid is what identifies a definition, so
    // recreating the same tool id cannot overwrite the earlier record.
    const stem = `clean_table-${UDT.data.uuid}`;
    const written = path.join(tmpDir, UDT_PROVENANCE_DIR, `${stem}.yaml`);
    expect(fs.existsSync(written)).toBe(true);
    expect(parseYaml(fs.readFileSync(written, "utf-8"))).toEqual(UDT.data.representation);

    const [block] = findUdtBlocks(notebook());
    expect(block.toolId).toBe("clean_table");
    expect(block.toolUuid).toBe("8d5f1c2e-9a0b-4c3d-8e7f-1a2b3c4d5e6f");
    expect(block.definition).toBe(`.loom/provenance/udt/${stem}.yaml`);
    expect(block.notebookAnchor).toBe("plan-a-step-2");
    expect(isUlid(block.attemptId!)).toBe(true);

    const [row] = activity().filter((r) => r.kind === "submission.registered");
    expect(row.payload.kind).toBe("udt");
    expect(row.payload.tool_uuid).toBe("8d5f1c2e-9a0b-4c3d-8e7f-1a2b3c4d5e6f");
    expect(row.payload.definition).toBe(`.loom/provenance/udt/${stem}.yaml`);
  });

  it("recreating a tool id under a new uuid keeps both definitions", async () => {
    await submit("galaxy_create_user_tool", {}, mcpResult(UDT));
    const second = {
      ...UDT,
      data: {
        ...UDT.data,
        uuid: "11112222-3333-4444-5555-666677778888",
        representation: { ...UDT.data.representation, version: "0.2.0" },
      },
    };
    await submit("galaxy_create_user_tool", {}, mcpResult(second));

    const dir = path.join(tmpDir, UDT_PROVENANCE_DIR);
    expect(fs.readdirSync(dir).sort()).toEqual([
      `clean_table-${second.data.uuid}.yaml`,
      `clean_table-${UDT.data.uuid}.yaml`,
    ]);

    // Two blocks, each pointing at its own definition rather than both at the
    // surviving file.
    const blocks = findUdtBlocks(notebook());
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks.map((b) => b.definition)).size).toBe(2);
    const v = (p: string) =>
      (parseYaml(fs.readFileSync(path.join(tmpDir, p), "utf-8")) as { version: string }).version;
    expect(blocks.map((b) => v(b.definition)).sort()).toEqual(["0.1.0", "0.2.0"]);
  });

  it("records nothing when the definition cannot be stored", async () => {
    // A uuid that sanitises away leaves nowhere to put the definition, and a
    // UDT block pointing at a file that is not there is worse than no block.
    await submit(
      "galaxy_create_user_tool",
      {},
      mcpResult({ data: { ...UDT.data, uuid: "...", tool_id: "..." }, success: true }),
    );
    expect(findUdtBlocks(notebook())).toHaveLength(0);
    expect(activity().filter((r) => r.kind === "submission.registered")).toHaveLength(0);
    expect(activity().filter((r) => r.kind === "submission.unparsed")).toHaveLength(1);
  });

  it("keeps a hostile tool id inside the provenance directory", async () => {
    await submit(
      "galaxy_create_user_tool",
      {},
      mcpResult({
        data: { ...UDT.data, tool_id: "../../../../etc/pwned" },
        success: true,
      }),
    );

    // Nothing anywhere but the provenance dir, and the escape attempt is flat.
    expect(fs.existsSync(path.join(tmpDir, "..", "etc"))).toBe(false);
    const dir = path.join(tmpDir, UDT_PROVENANCE_DIR);
    const written = fs.readdirSync(dir);
    expect(written).toEqual([`_.._.._.._etc_pwned-${UDT.data.uuid}.yaml`]);
    // No separator and no leading dot: it cannot escape and it is not hidden.
    expect(written[0]).not.toContain("/");
    expect(written[0].startsWith(".")).toBe(false);
  });
});

describe("safeProvenanceFilename", () => {
  it("passes ordinary tool ids through", () => {
    expect(safeProvenanceFilename("clean_table")).toBe("clean_table");
    expect(safeProvenanceFilename("clean-table.v2")).toBe("clean-table.v2");
  });

  it("flattens separators and traversal", () => {
    expect(safeProvenanceFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeProvenanceFilename("a/b\\c")).toBe("a_b_c");
  });

  it("strips leading dots so nothing becomes a hidden file or a traversal", () => {
    expect(safeProvenanceFilename("...")).toBeNull();
    expect(safeProvenanceFilename(".hidden")).toBe("hidden");
  });

  it("rejects an id with nothing usable in it", () => {
    expect(safeProvenanceFilename("")).toBeNull();
    expect(safeProvenanceFilename("///")).toBeNull();
  });

  it("caps the length", () => {
    expect(safeProvenanceFilename("x".repeat(500))!.length).toBe(120);
  });
});

describe("a replayed submission claims nothing about a server", () => {
  // LOOM_SUBMISSION_REPLAY feeds recorded fixtures through the same dispatch a
  // live submission takes, which is how Tier-1 drives capture without a model.
  // No tool ran and no server was asked, so the block it writes must not read
  // like one that did: `submitted_by: harness` and `server_verified: true` are
  // both claims about things that did not happen, and the `submission.replay`
  // activity row that marks them lives in a sidecar the analysis repo
  // gitignores while the notebook is the durable record.
  it("writes the block without submitted_by or server_verified", async () => {
    await handleSubmissionResult(
      "replay-0",
      "galaxy_invoke_workflow",
      mcpResult(INVOCATION),
      false,
      {
        args: {},
        stepAnchor: "plan-a-step-1",
        replayed: true,
      },
    );

    const content = notebook();
    expect(content).toContain("invocation_id: ff1e2d3c4b5a6978");
    expect(content).not.toContain("submitted_by:");
    expect(content).not.toContain("server_verified:");
    const [block] = findInvocationBlocks(content);
    expect(block.submittedBy).toBeUndefined();
    expect(block.serverVerified).toBeUndefined();
    // Still a record: the join key and the lifecycle ride along, because those
    // are facts about the record rather than claims about a server.
    expect(isUlid(block.attemptId ?? "")).toBe(true);
    expect(block.enrichment).toBe("pending");
    expect(block.notebookAnchor).toBe("plan-a-step-1");
  });

  it("says replay on the activity row rather than harness", async () => {
    await handleSubmissionResult(
      "replay-1",
      "galaxy_invoke_workflow",
      mcpResult(INVOCATION),
      false,
      {
        args: {},
        stepAnchor: "plan-a-step-1",
        replayed: true,
      },
    );
    const row = activity().find((e) => e.kind === "submission.registered");
    expect(row?.payload.submitted_by).toBe("replay");
  });

  it("refuses to overwrite a block that is already there", async () => {
    // Replay rebuilds a notebook from fixtures. A block already carrying that
    // id was written by something that actually happened, and overwriting it
    // would stamp a fixture's label and timestamp on a real run -- and the
    // carry-forward would hand the replay the real block's `submitted_by:
    // harness` on the way through, which is the one claim a replayed block is
    // not allowed to make.
    await handleSubmissionResult("live-0", "galaxy_invoke_workflow", mcpResult(INVOCATION), false, {
      args: {},
      stepAnchor: "plan-a-step-1",
    });
    const before = findInvocationBlocks(notebook())[0];

    await handleSubmissionResult(
      "replay-collide",
      "galaxy_invoke_workflow",
      mcpResult(INVOCATION),
      false,
      { args: {}, stepAnchor: "plan-a-step-9", replayed: true },
    );

    const blocks = findInvocationBlocks(notebook());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].attemptId).toBe(before.attemptId);
    expect(blocks[0].notebookAnchor).toBe("plan-a-step-1");
    expect(blocks[0].submittedBy).toBe("harness");
    expect(blocks[0].serverVerified).toBe(true);

    const skipped = activity().find((e) => e.kind === "submission.replay_skipped");
    expect(skipped?.payload.ids).toEqual(["ff1e2d3c4b5a6978"]);
  });

  it("refuses to overwrite a user-defined tool block that is already there", async () => {
    // The UDT block is keyed by uuid and was outside the first collision
    // check: a replay of the same creation rewrote a real block's anchor,
    // timestamp and attempt id with fixture values.
    await handleSubmissionResult("live-udt", "galaxy_create_user_tool", mcpResult(UDT), false, {
      args: {},
      stepAnchor: "plan-a-step-2",
    });
    const before = findUdtBlocks(notebook())[0];

    await handleSubmissionResult("replay-udt", "galaxy_create_user_tool", mcpResult(UDT), false, {
      args: {},
      stepAnchor: "plan-a-step-9",
      replayed: true,
    });

    const blocks = findUdtBlocks(notebook());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].notebookAnchor).toBe("plan-a-step-2");
    expect(blocks[0].attemptId).toBe(before.attemptId);
    expect(blocks[0].createdAt).toBe(before.createdAt);
    expect(activity().find((e) => e.kind === "submission.replay_skipped")?.payload.ids).toContain(
      "8d5f1c2e-9a0b-4c3d-8e7f-1a2b3c4d5e6f",
    );
  });

  it("does not announce a registration when every id was skipped", async () => {
    await handleSubmissionResult("live-2", "galaxy_invoke_workflow", mcpResult(INVOCATION), false, {
      args: {},
      stepAnchor: "plan-a-step-1",
    });
    const beforeCount = activity().filter((e) => e.kind === "submission.registered").length;

    await handleSubmissionResult(
      "replay-all-collide",
      "galaxy_invoke_workflow",
      mcpResult(INVOCATION),
      false,
      { args: {}, stepAnchor: "plan-a-step-9", replayed: true },
    );

    // Nothing landed, so nothing is claimed: a row saying otherwise would
    // point at a block that is not there.
    expect(activity().filter((e) => e.kind === "submission.registered")).toHaveLength(beforeCount);
    expect(activity().some((e) => e.kind === "submission.replay_skipped")).toBe(true);
  });

  it("still claims both when the submission was really watched", async () => {
    await handleSubmissionResult("live-0", "galaxy_invoke_workflow", mcpResult(INVOCATION), false, {
      args: {},
      stepAnchor: "plan-a-step-1",
    });

    const [block] = findInvocationBlocks(notebook());
    expect(block.submittedBy).toBe("harness");
    expect(block.serverVerified).toBe(true);
    expect(activity().find((e) => e.kind === "submission.registered")?.payload.submitted_by).toBe(
      "harness",
    );
  });
});
