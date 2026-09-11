/**
 * P0.6 -- transitions the poller makes are written to activity.jsonl.
 *
 * The poller calls checkInvocations directly instead of going through the tool
 * dispatcher, so a workflow that finished between turns produced a toast and a
 * rewritten block and no audit row at all. Work that advances while nobody is
 * watching is exactly the work that needs a record.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../extensions/loom/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/loom/tools.js")>();
  return { ...actual, checkInvocations: vi.fn() };
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
import { findJobBlocks, renderJobYaml, type JobYaml } from "../extensions/loom/galaxy-job-block";
import { galaxyGetJobDetails } from "../extensions/loom/galaxy-api.js";
import { checkInvocations } from "../extensions/loom/tools.js";
import {
  pollGalaxyNow,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/loom/galaxy-poller";

const mockCheck = vi.mocked(checkInvocations);
const mockJobDetails = vi.mocked(galaxyGetJobDetails);

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
    toolId: "bwa_mem",
    submittedAt: "2026-04-25T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

/** A checkInvocations return whose details carry per-invocation results. */
function resultWith(results: unknown[]) {
  return {
    content: [{ type: "text" as const, text: "{}" }],
    details: { checked: results.length, results },
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    invocationId: "inv-1",
    notebookAnchor: "plan-a-step-1",
    label: "QC workflow",
    priorStatus: "in_progress",
    jobSummary: { ok: 3, running: 0, queued: 0, error: 0, other: 0 },
    activeJobs: 0,
    newStatus: "completed",
    lastPolledAt: "2026-04-25T01:00:00Z",
    autoAction: "completed",
    ...overrides,
  };
}

describe("galaxy-poller activity log", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "loom-poller-activity-"));
    nbPath = join(dir, "notebook.md");
    writeFileSync(nbPath, "", "utf-8");
    setNotebookPath(nbPath);
    mockCheck.mockResolvedValue(resultWith([]));
  });

  afterEach(() => {
    stopGalaxyPoller();
    resetState();
    rmSync(dir, { recursive: true, force: true });
  });

  function transitions(): Record<string, unknown>[] {
    const file = join(dir, "activity.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.kind === "poll.transition");
  }

  /** Start a session without leaving the 15s interval armed, and poll once. */
  async function tick(): Promise<void> {
    startGalaxyPoller(() => {});
    stopGalaxyPoller();
    await pollGalaxyNow();
  }

  it("writes one row for an invocation that reached a terminal state", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    mockCheck.mockResolvedValue(resultWith([entry()]));

    await tick();

    const rows = transitions();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("galaxy-poller");
    expect(rows[0].payload).toMatchObject({
      blockKind: "invocation",
      id: "inv-1",
      label: "QC workflow",
      from: "in_progress",
      to: "completed",
      outcome: "completed",
      counters: { ok: 3, running: 0, queued: 0, error: 0, other: 0, active: 0 },
      lastPolledAt: "2026-04-25T01:00:00Z",
    });
  });

  it("writes one row per transition when several land in one tick", async () => {
    writeFileSync(
      nbPath,
      renderInvocationYaml(invocation()) +
        "\n" +
        renderInvocationYaml(invocation({ invocationId: "inv-2", notebookAnchor: "plan-a-s2" })),
      "utf-8",
    );
    mockCheck.mockResolvedValue(
      resultWith([
        entry(),
        entry({
          invocationId: "inv-2",
          autoAction: "failed",
          newStatus: "failed",
          jobSummary: { ok: 1, running: 0, queued: 0, error: 2, other: 0 },
        }),
      ]),
    );

    await tick();

    const rows = transitions();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.payload as Record<string, unknown>).to)).toEqual([
      "completed",
      "failed",
    ]);
  });

  it("writes nothing on a poll that changed no status", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    mockCheck.mockResolvedValue(
      resultWith([entry({ autoAction: undefined, newStatus: undefined })]),
    );

    await tick();
    await pollGalaxyNow();

    expect(transitions()).toEqual([]);
  });

  it("does not log a mid-flight failure as a transition -- the block is still in_progress", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    mockCheck.mockResolvedValue(
      resultWith([
        entry({
          autoAction: "failing",
          // A mid-flight failure writes a summary but leaves the status alone.
          newStatus: "in_progress",
          jobSummary: { ok: 0, running: 2, queued: 0, error: 1, other: 0 },
          activeJobs: 2,
        }),
      ]),
    );

    await tick();

    expect(transitions()).toEqual([]);
  });

  it("records a cancelled invocation by the status the block took, not the outcome", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    mockCheck.mockResolvedValue(
      resultWith([entry({ autoAction: "cancelled", newStatus: "failed" })]),
    );

    await tick();

    const rows = transitions();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ to: "failed", outcome: "cancelled" });
  });

  it("does not log a job transition another writer had already made", async () => {
    // The tick's opening snapshot says in_progress; another writer records the
    // outcome while the Galaxy request is in flight. The write still lands (it
    // refreshes last_polled_at), but the status change wasn't ours to announce.
    writeFileSync(nbPath, renderJobYaml(job()), "utf-8");
    mockJobDetails.mockImplementation(async () => {
      writeFileSync(nbPath, renderJobYaml(job({ status: "completed" })), "utf-8");
      return { id: "job-1", state: "ok", tool_id: "bwa_mem", tool_version: "1.0" };
    });

    await tick();

    expect(transitions()).toEqual([]);
    // The write itself is not suppressed -- the poll's stamp still lands.
    expect(findJobBlocks(readFileSync(nbPath, "utf-8"))[0].lastPolledAt).toBeTruthy();
  });

  it("logs a job block's transition too, once it has actually been written", async () => {
    writeFileSync(nbPath, renderJobYaml(job()), "utf-8");
    mockJobDetails.mockResolvedValue({
      id: "job-1",
      state: "ok",
      tool_id: "bwa_mem",
      tool_version: "1.0",
    });

    await tick();

    const rows = transitions();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      blockKind: "job",
      id: "job-1",
      label: "BWA alignment",
      toolId: "bwa_mem",
      from: "in_progress",
      to: "completed",
      galaxyState: "ok",
    });
    // The row and the notebook agree, and the row's stamp is the one written.
    const block = findJobBlocks(readFileSync(nbPath, "utf-8"))[0];
    expect(block.status).toBe("completed");
    expect((rows[0].payload as Record<string, unknown>).lastPolledAt).toBe(block.lastPolledAt);

    // Terminal blocks aren't polled again, so the row doesn't repeat.
    await pollGalaxyNow();
    expect(transitions()).toHaveLength(1);
  });
});
