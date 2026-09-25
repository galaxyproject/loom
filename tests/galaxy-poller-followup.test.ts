import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Exercise real notebook parsing, persistence and invocation transitions.
// Only Galaxy's API is replaced with deterministic responses.
vi.mock("../extensions/loom/galaxy-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/loom/galaxy-api.js")>()),
  getGalaxyConfig: vi.fn(() => ({ url: "https://galaxy.test", apiKey: "k" })),
  galaxyGet: vi.fn(),
  galaxyGetJobDetails: vi.fn(),
}));

import { resetState, setNotebookPath } from "../extensions/loom/state";
import { findInvocationBlocks, renderInvocationYaml } from "../extensions/loom/notebook-writer";
import { findJobBlocks, renderJobYaml } from "../extensions/loom/galaxy-job-block";
import { galaxyGet, galaxyGetJobDetails } from "../extensions/loom/galaxy-api.js";
import {
  registerSubmissionCapture,
  resetSubmissionCapture,
} from "../extensions/loom/galaxy-submission-capture";
import {
  pollGalaxyNow,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/loom/galaxy-poller";

const mockGet = vi.mocked(galaxyGet);
const mockJob = vi.mocked(galaxyGetJobDetails);
const common = {
  galaxyServerUrl: "https://galaxy.test",
  notebookAnchor: "test-step",
  label: "Same label",
  submittedAt: "2026-09-22T00:00:00Z",
  status: "in_progress" as const,
};
const jobBlock = (jobId: string) => renderJobYaml({ ...common, jobId });
const invocationBlock = () => renderInvocationYaml({ ...common, invocationId: "inv-1" });
const jobDetails = (id: string, state: string) => ({
  id,
  state,
  tool_id: "fastqc",
  tool_version: "1",
});
const invocationDetails = (states: string[], state = "scheduled") => ({
  id: "inv-1",
  state,
  workflow_id: "wf-1",
  history_id: "hist-1",
  steps: [
    {
      id: "step-1",
      order_index: 0,
      state: null,
      jobs: states.map((s, i) => ({ id: `workflow-job-${i}`, state: s, tool_id: "fastqc" })),
    },
  ],
});

function runsFrom(prompt: string) {
  return JSON.parse(
    prompt.slice(prompt.indexOf("[\n"), prompt.indexOf("\nRead the current notebook")),
  );
}

describe("automatic Galaxy follow-up", () => {
  let dir: string;
  let notebook: string;
  const notify = vi.fn();
  const resume = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(join(tmpdir(), "loom-followup-"));
    notebook = join(dir, "notebook.md");
    setNotebookPath(notebook);
    mockGet.mockResolvedValue(invocationDetails(["ok"]));
    mockJob.mockImplementation(async (id) => jobDetails(id, "ok"));
  });
  afterEach(async () => {
    stopGalaxyPoller();
    resetState();
    rmSync(dir, { recursive: true, force: true });
  });

  it("batches imports and workflows with exact IDs and persists results before delivery", async () => {
    writeFileSync(
      notebook,
      [jobBlock("job-ok"), jobBlock("job-error"), invocationBlock()].join("\n"),
    );
    mockJob.mockImplementation(async (id) => jobDetails(id, id === "job-error" ? "error" : "ok"));
    let contentAtDelivery = "";
    resume.mockImplementation(() => {
      contentAtDelivery = readFileSync(notebook, "utf8");
    });
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledOnce();
    expect(findJobBlocks(contentAtDelivery).map((j) => j.status)).toEqual(["completed", "failed"]);
    expect(findInvocationBlocks(contentAtDelivery)[0].status).toBe("completed");
    expect(runsFrom(resume.mock.calls[0][0])).toMatchObject([
      { kind: "job", id: "job-ok", outcome: "completed" },
      { kind: "job", id: "job-error", outcome: "failed" },
      { kind: "invocation", id: "inv-1", outcome: "completed" },
    ]);
    expect(notify.mock.calls.map(([text]) => text).join("\n")).not.toContain("ask me");
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("does not wake the agent for uploads that had already finished when captured", async () => {
    writeFileSync(notebook, "# Analysis\n");
    resetSubmissionCapture();
    const handlers: Record<string, ((event: any, ctx: any) => Promise<unknown>)[]> = {};
    registerSubmissionCapture({
      on: (event: string, h: (event: any, ctx: any) => Promise<unknown>) =>
        (handlers[event] ??= []).push(h),
    } as any);
    for (const [i, file] of ["a.fastq", "b.fastq", "c.fastq", "d.fastq"].entries()) {
      const toolCallId = `upload-${i}`;
      const toolName = "galaxy_upload_local_file";
      const args = { path: `/data/${file}` };
      for (const h of handlers.tool_execution_start) await h({ toolCallId, toolName, args }, {});
      for (const h of handlers.tool_execution_end) {
        await h(
          {
            toolCallId,
            toolName,
            args,
            isError: false,
            result: {
              content: [{ type: "text", text: "{}" }],
              details: { historyId: "hist-1", state: "ok", jobs: [`upload-job-${i}`] },
            },
          },
          {},
        );
      }
    }
    expect(findJobBlocks(readFileSync(notebook, "utf8"))).toHaveLength(4);

    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).not.toHaveBeenCalled();
    expect(mockJob).not.toHaveBeenCalled();
    resetSubmissionCapture();
  });

  it("investigates the first mid-flight failure once, then follows up on the terminal failure", async () => {
    writeFileSync(notebook, invocationBlock());
    mockGet.mockResolvedValue(invocationDetails(["error", "running"]));
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledOnce();
    expect(runsFrom(resume.mock.calls[0][0])[0]).toMatchObject({
      outcome: "failing",
      detail: "1 job(s) failed, 1 still running",
    });
    expect(findInvocationBlocks(readFileSync(notebook, "utf8"))[0].status).toBe("in_progress");
    mockGet.mockResolvedValue(invocationDetails(["error", "ok"]));
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(runsFrom(resume.mock.calls[1][0])[0].outcome).toBe("failed");
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("does not revive cancelled or skipped work", async () => {
    writeFileSync(
      notebook,
      [jobBlock("cancelled"), jobBlock("skipped"), invocationBlock()].join("\n"),
    );
    mockJob.mockImplementation(async (id) =>
      jobDetails(id, id === "cancelled" ? "deleted" : "skipped"),
    );
    mockGet.mockResolvedValue(invocationDetails([], "cancelled"));
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("still follows up without a UI or when the notifier throws", async () => {
    writeFileSync(notebook, jobBlock("job-1"));
    startGalaxyPoller(undefined, resume);
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledOnce();
    writeFileSync(notebook, jobBlock("job-2"));
    notify.mockImplementation(() => {
      throw new Error("UI gone");
    });
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("still delivers completed jobs when a workflow poll fails", async () => {
    writeFileSync(notebook, jobBlock("job-1") + "\n" + invocationBlock());
    mockGet.mockRejectedValue(new Error("Galaxy unavailable"));
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledOnce();
    expect(runsFrom(resume.mock.calls[0][0])).toMatchObject([{ kind: "job", id: "job-1" }]);
  });

  it("shows an honest status when automatic follow-up is disabled", async () => {
    writeFileSync(notebook, jobBlock("job-1"));
    startGalaxyPoller(notify);
    await pollGalaxyNow();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("automatic follow-up disabled"),
      "info",
    );
    expect(resume).not.toHaveBeenCalled();
  });

  // Holds a job poll open so the session can be stopped or replaced mid-tick.
  async function stallFirstJobPoll() {
    writeFileSync(notebook, jobBlock("job-1"));
    let resolve!: (value: ReturnType<typeof jobDetails>) => void;
    mockJob.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    startGalaxyPoller(notify, resume);
    await vi.waitFor(() => expect(mockJob).toHaveBeenCalledOnce());
    return () => resolve(jobDetails("job-1", "ok"));
  }

  it("does not wake a stopped session", async () => {
    const finish = await stallFirstJobPoll();
    stopGalaxyPoller();
    finish();
    await pollGalaxyNow();
    expect(resume).not.toHaveBeenCalled();
  });

  it("hands a mid-tick transition to a replacement session on the same notebook", async () => {
    // The stale tick persists the job as completed, so the replacement's own
    // polls never see it in_progress again -- dropping it here would lose the
    // verification for good.
    const finish = await stallFirstJobPoll();
    const replacement = vi.fn();
    startGalaxyPoller(notify, replacement);
    finish();
    await pollGalaxyNow();
    expect(resume).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
    expect(runsFrom(replacement.mock.calls[0][0])).toMatchObject([{ id: "job-1" }]);
  });

  it("does not hand a stale tick's runs to a session on another notebook", async () => {
    const finish = await stallFirstJobPoll();
    setNotebookPath(join(dir, "other.md"));
    const replacement = vi.fn();
    startGalaxyPoller(notify, replacement);
    finish();
    await pollGalaxyNow();
    expect(resume).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  });
});
