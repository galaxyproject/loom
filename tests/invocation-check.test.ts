import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { renderInvocationYaml, type InvocationYaml } from "../extensions/loom/notebook-writer";
import * as galaxyApi from "../extensions/loom/galaxy-api";
import { checkInvocations } from "../extensions/loom/tools";

function invocation(overrides: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "inv-1",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-1",
    label: "QC workflow",
    submittedAt: "2026-04-25T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

/**
 * A GET /invocations/{id} response: the invocation's own scheduling `state`
 * plus one step holding a job per entry in `jobStates`.
 */
function galaxyInvocation(state: string, jobStates: string[]) {
  return {
    id: "inv-1",
    state,
    workflow_id: "wf-1",
    history_id: "hist-1",
    steps: [
      {
        id: "step-1",
        order_index: 0,
        state: null,
        jobs: jobStates.map((s, i) => ({ id: `job-${i}`, state: s, tool_id: "fastqc" })),
      },
    ],
  };
}

describe("checkInvocations", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-invocation-check-"));
    nbPath = join(dir, "notebook.md");
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
    setNotebookPath(nbPath);
  });

  afterEach(() => {
    resetState();
    vi.restoreAllMocks();
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks an invocation completed when all jobs are ok", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue({
      id: "inv-1",
      state: "scheduled",
      workflow_id: "wf-1",
      history_id: "hist-1",
      steps: [
        {
          id: "step-1",
          order_index: 0,
          state: null,
          jobs: [
            { id: "job-1", state: "ok", tool_id: "fastqc" },
            { id: "job-2", state: "ok", tool_id: "multiqc" },
          ],
        },
      ],
    });

    const result = await checkInvocations(undefined);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.checked).toBe(1);
    expect(parsed.results[0].autoAction).toBe("completed");
    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).toContain("status: completed");
    expect(notebook).toContain("Workflow completed: 2 jobs succeeded");
  });

  it("marks an invocation failed when any job errors", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue({
      id: "inv-1",
      state: "scheduled",
      workflow_id: "wf-1",
      history_id: "hist-1",
      steps: [
        {
          id: "step-1",
          order_index: 0,
          state: null,
          jobs: [
            { id: "job-1", state: "ok", tool_id: "fastqc" },
            { id: "job-2", state: "error", tool_id: "multiqc" },
          ],
        },
      ],
    });

    const result = await checkInvocations("inv-1");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.results[0].autoAction).toBe("failed");
    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).toContain("status: failed");
    expect(notebook).toContain("Workflow failed: 1 job(s) errored, 1 succeeded");
  });

  it("asks Galaxy for step details, without which every job counter is zero", async () => {
    // Regression: the fetch omitted `step_details=true`. Galaxy still returns a
    // `jobs` key on every step but leaves it empty, so totalJobs came back 0,
    // neither the completed nor the failed branch could fire, and blocks sat at
    // in_progress forever -- no status transition, no toast. Every test here
    // mocks galaxyGet with jobs already populated (what step_details returns),
    // which is exactly why the suite stayed green while this was broken. Assert
    // the request itself, since a mocked response cannot catch it.
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    const galaxyGet = vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue({
      id: "inv-1",
      state: "scheduled",
      workflow_id: "wf-1",
      history_id: "hist-1",
      steps: [],
    });

    await checkInvocations(undefined);

    expect(galaxyGet).toHaveBeenCalledWith(expect.stringContaining("step_details=true"), undefined);
  });

  it("does not rewrite already completed invocations in check_all", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation({ status: "completed" })), "utf-8");
    const galaxyGet = vi.spyOn(galaxyApi, "galaxyGet");

    const result = await checkInvocations(undefined);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.results).toEqual([]);
    expect(galaxyGet).not.toHaveBeenCalled();
  });
});

/**
 * The completion predicate (P0.4). Before this, a poll asked only about the
 * jobs Galaxy had materialized so far: an invocation still scheduling with two
 * jobs already ok reported "completed", a paused job was ignored entirely, and
 * one error stopped the observation of everything still running.
 */
describe("checkInvocations completion predicate", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-completion-predicate-"));
    nbPath = join(dir, "notebook.md");
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
    setNotebookPath(nbPath);
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
  });

  afterEach(() => {
    resetState();
    vi.restoreAllMocks();
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  async function poll(state: string, jobStates: string[]) {
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(galaxyInvocation(state, jobStates));
    const result = await checkInvocations(undefined);
    return {
      entry: JSON.parse(result.content[0].text).results[0],
      notebook: readFileSync(nbPath, "utf-8"),
    };
  }

  it("says nothing about an invocation Galaxy has not started scheduling", async () => {
    const { entry, notebook } = await poll("new", []);

    expect(entry.autoAction).toBeUndefined();
    expect(notebook).toContain("status: in_progress");
  });

  it("does not call a still-scheduling invocation complete just because its jobs are ok", async () => {
    const { entry, notebook } = await poll("ready", ["ok", "ok"]);

    expect(entry.autoAction).toBeUndefined();
    expect(notebook).toContain("status: in_progress");
    expect(notebook).toContain("completed_jobs: 2");
  });

  it("does not complete while a job is paused", async () => {
    const { entry, notebook } = await poll("scheduled", ["ok", "paused"]);

    expect(entry.autoAction).toBeUndefined();
    expect(entry.otherStates).toEqual({ paused: 1 });
    expect(entry.activeJobs).toBe(1);
    expect(notebook).toContain("status: in_progress");
  });

  it("completes past a skipped job -- a conditional step that never runs is not work in flight", async () => {
    const { entry, notebook } = await poll("scheduled", ["ok", "skipped"]);

    expect(entry.autoAction).toBe("completed");
    expect(notebook).toContain("status: completed");
    expect(notebook).toContain("1 skipped");
  });

  it("keeps observing when a job errors while others still run", async () => {
    const { entry, notebook } = await poll("scheduled", ["error", "running"]);

    expect(entry.autoAction).toBe("failing");
    expect(notebook).toContain("status: in_progress");
    expect(notebook).toContain("failed_jobs: 1");
    expect(notebook).toContain("1 job(s) failed, 1 still running");
  });

  it("transitions to failed once nothing is active", async () => {
    const { entry, notebook } = await poll("scheduled", ["error", "ok"]);

    expect(entry.autoAction).toBe("failed");
    expect(notebook).toContain("status: failed");
    expect(notebook).toContain("Workflow failed: 1 job(s) errored, 1 succeeded");
  });

  it("counts a `failed` job as an error rather than filing it under other", async () => {
    const { entry } = await poll("scheduled", ["failed", "ok"]);

    expect(entry.jobSummary.error).toBe(1);
    expect(entry.jobSummary.other).toBe(0);
    expect(entry.autoAction).toBe("failed");
  });

  it("closes out a cancelled invocation instead of watching it forever", async () => {
    const { entry, notebook } = await poll("cancelled", ["ok", "ok"]);

    // No third word for it in the block, so it lands terminal and the summary
    // carries the truth -- but the poller is told it was a cancel, not a crash.
    expect(entry.autoAction).toBe("cancelled");
    expect(notebook).toContain("status: failed");
    expect(notebook).toContain("Workflow cancelled: 2 job(s) finished before it stopped");
  });

  it("says cancelled, not failed, when the cancel deleted jobs on its way out", async () => {
    const { entry, notebook } = await poll("cancelled", ["ok", "deleted"]);

    expect(entry.autoAction).toBe("cancelled");
    expect(notebook).toContain("1 job(s) finished before it stopped, 1 did not");
  });

  it("fails an invocation Galaxy could not schedule, even with no errored job", async () => {
    const { entry, notebook } = await poll("failed", ["ok"]);

    expect(entry.autoAction).toBe("failed");
    expect(notebook).toContain("status: failed");
  });
});
