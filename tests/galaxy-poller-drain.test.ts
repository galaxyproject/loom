/**
 * The bounded drain an eval's json-mode run waits on before it quits, so a job that finishes
 * between the model's last reply and the next 15 s tick still lands its poll.transition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../extensions/orbit/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/orbit/tools.js")>();
  return { ...actual, checkInvocations: vi.fn() };
});

vi.mock("../extensions/orbit/galaxy-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/orbit/galaxy-api.js")>();
  return {
    ...actual,
    getGalaxyConfig: vi.fn(() => ({ url: "https://galaxy.test", apiKey: "k" })),
    galaxyGet: vi.fn(),
    galaxyGetJobDetails: vi.fn(),
  };
});

import { resetState, setNotebookPath } from "../extensions/orbit/state";
import { renderJobYaml, type JobYaml } from "../extensions/orbit/galaxy-job-block";
import { renderInvocationYaml } from "../extensions/orbit/notebook-writer";
import { galaxyGetJobDetails } from "../extensions/orbit/galaxy-api.js";
import { checkInvocations } from "../extensions/orbit/tools.js";
import {
  drainGalaxyPoller,
  pollGalaxyNow,
  setCaptureTickHook,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/orbit/galaxy-poller";

const mockJobDetails = vi.mocked(galaxyGetJobDetails);

function job(overrides: Partial<JobYaml> = {}): JobYaml {
  return {
    jobId: "job-1",
    galaxyServerUrl: "https://galaxy.test",
    notebookAnchor: "plan-a-step-1",
    label: "Count lines",
    toolId: "wc_gnu",
    submittedAt: "2026-10-17T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

const details = (state: string) => ({ id: "job-1", state, tool_id: "wc_gnu", tool_version: "1" });

describe("drainGalaxyPoller", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "loom-poller-drain-"));
    nbPath = join(dir, "notebook.md");
    writeFileSync(nbPath, renderJobYaml(job()), "utf-8");
    setNotebookPath(nbPath);
    vi.mocked(checkInvocations).mockResolvedValue({
      content: [{ type: "text" as const, text: "{}" }],
      details: { checked: 0, results: [] },
    } as never);
  });

  afterEach(() => {
    setCaptureTickHook(null);
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

  it("ticks until the job finishes and logs its transition", async () => {
    mockJobDetails
      .mockResolvedValueOnce(details("running"))
      .mockResolvedValueOnce(details("running"))
      .mockResolvedValue(details("ok"));
    await expect(drainGalaxyPoller({ timeoutMs: 2_000, intervalMs: 5 })).resolves.toBe(true);
    expect(transitions().map((r) => r.payload)).toEqual([
      expect.objectContaining({ blockKind: "job", toolId: "wc_gnu", to: "completed" }),
    ]);
  });

  it("gives up at the deadline without throwing", async () => {
    mockJobDetails.mockResolvedValue(details("running"));
    await expect(drainGalaxyPoller({ timeoutMs: 60, intervalMs: 5 })).resolves.toBe(false);
    expect(transitions()).toEqual([]);
  });

  it("gives up at the deadline even while a poll request never answers", async () => {
    let answer!: (v: ReturnType<typeof details>) => void;
    mockJobDetails.mockReturnValue(new Promise((r) => (answer = r)));
    const started = Date.now();
    await expect(drainGalaxyPoller({ timeoutMs: 60, intervalMs: 5 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    // The stalled tick is shared module state; let it finish so the next test starts clean.
    answer(details("running"));
    await new Promise((r) => setTimeout(r, 20));
  });

  it("leaves the notebook, the log and capture alone when a tick it gave up on answers late", async () => {
    let answer!: (v: ReturnType<typeof details>) => void;
    mockJobDetails.mockReturnValue(new Promise((r) => (answer = r)));
    const capture = vi.fn(async () => {});
    setCaptureTickHook(capture);
    const before = readFileSync(nbPath, "utf-8");
    await expect(drainGalaxyPoller({ timeoutMs: 60, intervalMs: 5 })).resolves.toBe(false);
    answer(details("ok"));
    await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(nbPath, "utf-8")).toBe(before);
    expect(transitions()).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
  });

  it("sends no follow-up into a session that is shutting down", async () => {
    mockJobDetails.mockResolvedValue(details("running"));
    const resumeFn = vi.fn();
    startGalaxyPoller(undefined, resumeFn);
    mockJobDetails.mockResolvedValue(details("ok"));
    await drainGalaxyPoller({ timeoutMs: 2_000, intervalMs: 5 });
    expect(transitions()).toHaveLength(1);
    expect(resumeFn).not.toHaveBeenCalled();
  });

  it("returns after one tick when nothing is in flight", async () => {
    writeFileSync(nbPath, renderJobYaml(job({ status: "completed" })), "utf-8");
    const started = Date.now();
    await expect(drainGalaxyPoller({ timeoutMs: 5_000, intervalMs: 1_000 })).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(900);
    expect(mockJobDetails).not.toHaveBeenCalled();
  });
  it("logs, toasts and resumes nothing for an invocation check it gave up on", async () => {
    writeFileSync(
      nbPath,
      renderInvocationYaml({
        invocationId: "inv-1",
        galaxyServerUrl: "https://galaxy.test",
        notebookAnchor: "plan-a-step-1",
        label: "QC workflow",
        submittedAt: "2026-10-17T00:00:00Z",
        status: "in_progress",
      }),
      "utf-8",
    );
    let answer!: (v: unknown) => void;
    vi.mocked(checkInvocations).mockReturnValue(new Promise((r) => (answer = r)) as never);
    const notify = vi.fn();
    startGalaxyPoller(notify);
    await expect(drainGalaxyPoller({ timeoutMs: 60, intervalMs: 5 })).resolves.toBe(false);
    // The check's own write is skipped through the signal it was handed.
    const signal = vi.mocked(checkInvocations).mock.calls[0]![1] as AbortSignal | undefined;
    expect(signal?.aborted).toBe(true);
    answer({
      content: [{ type: "text", text: "{}" }],
      details: {
        results: [
          {
            invocationId: "inv-1",
            label: "QC workflow",
            autoAction: "completed",
            priorStatus: "in_progress",
            newStatus: "completed",
            jobSummary: { ok: 2 },
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(transitions()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("polls no further jobs once a stalled one outlives the drain", async () => {
    writeFileSync(
      nbPath,
      renderJobYaml(job()) + "\n" + renderJobYaml(job({ jobId: "job-2", notebookAnchor: "s2" })),
      "utf-8",
    );
    let answer!: (v: ReturnType<typeof details>) => void;
    mockJobDetails.mockReturnValueOnce(new Promise((r) => (answer = r)));
    mockJobDetails.mockResolvedValue(details("running"));
    await expect(drainGalaxyPoller({ timeoutMs: 60, intervalMs: 5 })).resolves.toBe(false);
    expect(mockJobDetails.mock.calls[0]![1]?.aborted).toBe(true);
    answer(details("ok"));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockJobDetails).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh tick after giving up on one that never answers", async () => {
    // Only job-1's GETs: a block an earlier test tracked gets a liveness check of its own.
    let stall = true;
    mockJobDetails.mockImplementation(async (id) => {
      if (id === "job-1" && stall) {
        stall = false;
        return new Promise(() => {});
      }
      return details("running");
    });
    await expect(drainGalaxyPoller({ timeoutMs: 60, intervalMs: 5 })).resolves.toBe(false);
    expect(stall).toBe(false);
    const polls = () => mockJobDetails.mock.calls.filter(([id]) => id === "job-1").length;
    const before = polls();
    await pollGalaxyNow();
    expect(polls()).toBe(before + 1);
  });

  it("does not call an unreadable notebook drained", async () => {
    // There but unreadable (EISDIR here; a failed page GET for a Galaxy-page record).
    rmSync(nbPath);
    mkdirSync(nbPath);
    await expect(drainGalaxyPoller({ timeoutMs: 60, intervalMs: 5 })).resolves.toBe(false);
  });

  it("calls a notebook that is gone drained", async () => {
    rmSync(nbPath);
    await expect(drainGalaxyPoller({ timeoutMs: 2_000, intervalMs: 5 })).resolves.toBe(true);
  });
});
