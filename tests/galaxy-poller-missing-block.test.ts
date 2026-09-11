/**
 * P0.5 -- the poller can no longer be silenced by deleting a block.
 *
 * The notebook is the poller's only index of what to watch, so removing an
 * in-flight block used to end the observation with nothing said: no toast, no
 * activity row, and a Galaxy run still going with nobody watching. The poller
 * now remembers what it has seen in flight and, when a block disappears while
 * Galaxy still reports the run alive, says so once.
 *
 * Real notebook, real block parsing, real activity log on disk; only Galaxy and
 * the invocation check are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../extensions/loom/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/loom/tools.js")>();
  return {
    ...actual,
    checkInvocations: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "{}" }],
      details: { checked: 0 },
    })),
  };
});

vi.mock("../extensions/loom/galaxy-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/loom/galaxy-api.js")>();
  return {
    ...actual,
    getGalaxyConfig: vi.fn(() => ({ url: "https://galaxy.test", apiKey: "k" })),
    galaxyGet: vi.fn(),
    galaxyGetJobDetails: vi.fn(),
  };
});

import { resetState, setNotebookPath } from "../extensions/loom/state";
import { renderInvocationYaml, type InvocationYaml } from "../extensions/loom/notebook-writer";
import { renderJobYaml, type JobYaml } from "../extensions/loom/galaxy-job-block";
import { galaxyGet, galaxyGetJobDetails } from "../extensions/loom/galaxy-api.js";
import { checkInvocations } from "../extensions/loom/tools.js";
import {
  pollGalaxyNow,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/loom/galaxy-poller";

const mockGalaxyGet = vi.mocked(galaxyGet);
const mockJobDetails = vi.mocked(galaxyGetJobDetails);
const mockCheck = vi.mocked(checkInvocations);

function invocation(overrides: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "inv-1",
    galaxyServerUrl: "https://galaxy.test",
    notebookAnchor: "plan-a-step-1",
    label: "QC workflow",
    submittedAt: "2026-04-25T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

function job(overrides: Partial<JobYaml> = {}): JobYaml {
  return {
    jobId: "job-1",
    galaxyServerUrl: "https://galaxy.test",
    notebookAnchor: "plan-a-step-2",
    label: "BWA alignment",
    submittedAt: "2026-04-25T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

/** A GET /invocations/{id} response with one job in `jobState`. */
function invocationResponse(state: string, jobState: string) {
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
        jobs: [{ id: "j1", state: jobState, tool_id: "fastqc" }],
      },
    ],
  };
}

describe("galaxy-poller missing-block reporting", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "loom-poller-missing-"));
    nbPath = join(dir, "notebook.md");
    writeFileSync(nbPath, "", "utf-8");
    setNotebookPath(nbPath);
  });

  afterEach(() => {
    stopGalaxyPoller();
    resetState();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Start a session (which sets the notifier and clears the tracked ids) and
   * wait out its opening tick, without leaving the 15s interval armed.
   */
  async function firstTick(
    notify: (text: string, level: "info" | "warning" | "error") => void,
  ): Promise<void> {
    startGalaxyPoller(notify);
    stopGalaxyPoller();
    await pollGalaxyNow();
  }

  function activityRows(): Record<string, unknown>[] {
    const file = join(dir, "activity.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("warns once, and logs once, when a live invocation's block is deleted", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    // Still scheduling on Galaxy: this run is very much alive.
    mockGalaxyGet.mockResolvedValue(invocationResponse("ready", "running") as never);
    const notify = vi.fn();

    // First tick sees the block in flight and starts tracking it.
    await firstTick(notify);
    expect(notify).not.toHaveBeenCalled();

    // The agent prunes the block, and with it the poller's only handle on the run.
    writeFileSync(nbPath, "# Notes\n\nblock removed by the agent\n", "utf-8");
    await pollGalaxyNow();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("QC workflow");
    expect(notify.mock.calls[0][1]).toBe("warning");

    const missing = activityRows().filter((r) => r.kind === "poll.block_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].source).toBe("galaxy-poller");
    expect(missing[0].payload).toMatchObject({
      blockKind: "invocation",
      id: "inv-1",
      label: "QC workflow",
      galaxyState: "ready",
    });

    // Later ticks have nothing new to say about it.
    await pollGalaxyNow();
    await pollGalaxyNow();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(activityRows().filter((r) => r.kind === "poll.block_missing")).toHaveLength(1);
  });

  it("keeps polling the blocks that are still there", async () => {
    writeFileSync(
      nbPath,
      renderInvocationYaml(invocation()) +
        "\n" +
        renderInvocationYaml(
          invocation({
            invocationId: "inv-2",
            notebookAnchor: "plan-a-step-9",
            label: "Assembly",
          }),
        ),
      "utf-8",
    );
    mockGalaxyGet.mockResolvedValue(invocationResponse("ready", "running") as never);
    const notify = vi.fn();

    await firstTick(notify);
    const polledBefore = mockCheck.mock.calls.length;

    // Only the first block goes.
    writeFileSync(
      nbPath,
      renderInvocationYaml(
        invocation({
          invocationId: "inv-2",
          notebookAnchor: "plan-a-step-9",
          label: "Assembly",
        }),
      ),
      "utf-8",
    );
    await pollGalaxyNow();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("QC workflow");
    // inv-2 is still in the notebook and still gets polled.
    expect(mockCheck.mock.calls.length).toBeGreaterThan(polledBefore);
  });

  it("says nothing when the run had already finished before its block went", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    mockGalaxyGet.mockResolvedValue(invocationResponse("scheduled", "ok") as never);
    const notify = vi.fn();

    await firstTick(notify);
    writeFileSync(nbPath, "# Notes\n", "utf-8");
    await pollGalaxyNow();

    expect(notify).not.toHaveBeenCalled();
    expect(activityRows().filter((r) => r.kind === "poll.block_missing")).toHaveLength(0);
  });

  it("reports a deleted job block the same way", async () => {
    writeFileSync(nbPath, renderJobYaml(job()), "utf-8");
    mockJobDetails.mockResolvedValue({
      id: "job-1",
      state: "running",
      tool_id: "bwa",
      tool_version: "1.0",
    });
    const notify = vi.fn();

    await firstTick(notify);
    writeFileSync(nbPath, "# Notes\n", "utf-8");
    await pollGalaxyNow();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("BWA alignment");
    const missing = activityRows().filter((r) => r.kind === "poll.block_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].payload).toMatchObject({ blockKind: "job", id: "job-1" });
  });

  it("reports the whole notebook disappearing, not just one block", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    mockGalaxyGet.mockResolvedValue(invocationResponse("ready", "running") as never);
    const notify = vi.fn();

    await firstTick(notify);
    rmSync(nbPath, { force: true });
    await pollGalaxyNow();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("QC workflow");
  });

  it("gives up on an id Galaxy keeps refusing rather than asking forever", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    mockGalaxyGet.mockRejectedValue(new Error("Galaxy API 404"));
    const notify = vi.fn();

    await firstTick(notify);
    writeFileSync(nbPath, "# Notes\n", "utf-8");
    for (let i = 0; i < 6; i++) await pollGalaxyNow();

    // Three attempts, then the id is dropped -- not one round trip per tick for
    // the rest of the session.
    expect(mockGalaxyGet).toHaveBeenCalledTimes(3);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the id tracked when Galaxy can't be reached for the verdict", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    mockGalaxyGet.mockRejectedValueOnce(new Error("Galaxy API 503"));
    const notify = vi.fn();

    await firstTick(notify);
    writeFileSync(nbPath, "# Notes\n", "utf-8");
    await pollGalaxyNow();

    expect(notify).not.toHaveBeenCalled();

    // The next tick gets an answer, and the warning lands then.
    mockGalaxyGet.mockResolvedValue(invocationResponse("ready", "running") as never);
    await pollGalaxyNow();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
