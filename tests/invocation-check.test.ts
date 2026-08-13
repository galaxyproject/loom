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
