/**
 * The poller settles what the record tools could not.
 *
 * A record written while Galaxy was unreachable carries `server_verified:
 * false` -- an honest "we wrote this down without confirming it". The first
 * poll that gets an answer out of Galaxy is that confirmation, so it clears the
 * flag. Nothing else about the poller's behaviour changes: no toast, no
 * transition, and a block that never carried the flag is left alone.
 *
 * Real notebook on disk, real block parsing; only Galaxy is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../extensions/loom/galaxy-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/loom/galaxy-api.js")>();
  return {
    ...actual,
    getGalaxyConfig: vi.fn(() => ({ url: "https://galaxy.test", apiKey: "k" })),
    galaxyGetInvocation: vi.fn(),
    galaxyGetJobDetails: vi.fn(),
  };
});

import { resetState, setNotebookPath } from "../extensions/loom/state";
import { findInvocationBlocks, renderInvocationYaml } from "../extensions/loom/notebook-writer";
import { findJobBlocks, renderJobYaml, type JobYaml } from "../extensions/loom/galaxy-job-block";
import { galaxyGetInvocation, galaxyGetJobDetails } from "../extensions/loom/galaxy-api.js";
import {
  pollGalaxyNow,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/loom/galaxy-poller";

const mockGalaxyGet = vi.mocked(galaxyGetInvocation);
const mockJobDetails = vi.mocked(galaxyGetJobDetails);

function job(overrides: Partial<JobYaml> = {}): JobYaml {
  return {
    jobId: "job-1",
    galaxyServerUrl: "https://galaxy.test",
    notebookAnchor: "plan-a-step-1",
    label: "FastQC",
    submittedAt: "2026-09-16T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

function invocationResponse(state: string, jobStates: string[]) {
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

describe("poller clears server_verified: false", () => {
  let dir: string;
  let nbPath: string;
  const notify = vi.fn();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-poll-verify-"));
    nbPath = join(dir, "notebook.md");
    setNotebookPath(nbPath);
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopGalaxyPoller();
    resetState();
    rmSync(dir, { recursive: true, force: true });
  });

  it("clears the flag on a job that is still running, without announcing anything", async () => {
    // The job path only writes on a terminal state, so without this the flag
    // would sit false for the whole run and clear only when the job ended.
    writeFileSync(nbPath, renderJobYaml(job({ serverVerified: false })), "utf-8");
    mockJobDetails.mockResolvedValue({
      id: "job-1",
      state: "running",
      tool_id: "fastqc",
      tool_version: "1.0",
    });

    startGalaxyPoller(notify);
    await pollGalaxyNow();

    const block = findJobBlocks(readFileSync(nbPath, "utf-8"))[0];
    expect(block.serverVerified).toBe(true);
    expect(block.status).toBe("in_progress");
    expect(notify).not.toHaveBeenCalled();
  });

  it("clears the flag on the poll that finishes the job", async () => {
    writeFileSync(nbPath, renderJobYaml(job({ serverVerified: false })), "utf-8");
    mockJobDetails.mockResolvedValue({
      id: "job-1",
      state: "ok",
      tool_id: "fastqc",
      tool_version: "1.0",
    });

    startGalaxyPoller(notify);
    await pollGalaxyNow();

    const block = findJobBlocks(readFileSync(nbPath, "utf-8"))[0];
    expect(block.serverVerified).toBe(true);
    expect(block.status).toBe("completed");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("records the current Galaxy queue state without inventing a verification flag", async () => {
    // The pre-existing shape. One extra write per tick, per job, forever would
    // be a poor trade for a field nobody claimed.
    writeFileSync(nbPath, renderJobYaml(job()), "utf-8");

    mockJobDetails.mockResolvedValue({
      id: "job-1",
      state: "running",
      tool_id: "fastqc",
      tool_version: "1.0",
    });

    startGalaxyPoller(notify);
    await pollGalaxyNow();

    expect(readFileSync(nbPath, "utf-8")).toContain("galaxy_state: running");
    expect(readFileSync(nbPath, "utf-8")).not.toContain("server_verified:");
  });

  it("clears the flag on an invocation the check could poll", async () => {
    writeFileSync(
      nbPath,
      renderInvocationYaml({
        invocationId: "inv-1",
        galaxyServerUrl: "https://galaxy.test",
        notebookAnchor: "plan-a-step-1",
        label: "QC workflow",
        submittedAt: "2026-09-16T00:00:00Z",
        status: "in_progress",
        serverVerified: false,
      }),
      "utf-8",
    );
    // Still scheduling, so no transition -- the flag clears on the round trip
    // itself, not on reaching a terminal state.
    mockGalaxyGet.mockResolvedValue(invocationResponse("new", ["queued"]) as never);

    startGalaxyPoller(notify);
    await pollGalaxyNow();

    const block = findInvocationBlocks(readFileSync(nbPath, "utf-8"))[0];
    expect(block.serverVerified).toBe(true);
    expect(block.status).toBe("in_progress");
  });

  it("does not let another Galaxy server certify a block recorded against ours", async () => {
    // The poller always asks the currently-configured server, so after a
    // profile switch it polls server B about a block recorded against A. It
    // may advance the run -- that is pre-existing -- but B's answer is not
    // proof that A's id exists.
    writeFileSync(
      nbPath,
      renderJobYaml(job({ galaxyServerUrl: "https://other.galaxy.test", serverVerified: false })),
      "utf-8",
    );
    mockJobDetails.mockResolvedValue({
      id: "job-1",
      state: "running",
      tool_id: "fastqc",
      tool_version: "1.0",
    });

    startGalaxyPoller(notify);
    await pollGalaxyNow();

    expect(findJobBlocks(readFileSync(nbPath, "utf-8"))[0].serverVerified).toBe(false);
  });

  it("still clears the flag when the block names the server we are polling", async () => {
    writeFileSync(
      nbPath,
      renderJobYaml(job({ galaxyServerUrl: "https://GALAXY.test/", serverVerified: false })),
      "utf-8",
    );
    mockJobDetails.mockResolvedValue({
      id: "job-1",
      state: "ok",
      tool_id: "fastqc",
      tool_version: "1.0",
    });

    startGalaxyPoller(notify);
    await pollGalaxyNow();

    expect(findJobBlocks(readFileSync(nbPath, "utf-8"))[0].serverVerified).toBe(true);
  });

  it("leaves the flag false when Galaxy does not answer", async () => {
    writeFileSync(nbPath, renderJobYaml(job({ serverVerified: false })), "utf-8");
    mockJobDetails.mockRejectedValue(new Error("Galaxy API 502: bad gateway"));

    startGalaxyPoller(notify);
    await pollGalaxyNow();

    expect(findJobBlocks(readFileSync(nbPath, "utf-8"))[0].serverVerified).toBe(false);
  });
});
