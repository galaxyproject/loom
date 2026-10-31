/**
 * The poller under the browser worker (slice 3, commit 5): no clock of its own, every tick driven
 * through pollGalaxyNow, which reports what the tick left behind; and a tick that spans a session
 * switch writes by the record it started on without touching the next session's state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../extensions/orbit/galaxy-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/orbit/galaxy-api.js")>()),
  getGalaxyConfig: vi.fn(() => ({ url: "https://galaxy.test", apiKey: "k" })),
  galaxyGetJobDetails: vi.fn(),
}));

import { galaxyGetJobDetails } from "../extensions/orbit/galaxy-api.js";
import { findJobBlocks, renderJobYaml } from "../extensions/orbit/galaxy-job-block";
import {
  pollerIdle,
  pollGalaxyNow,
  setCaptureTickHook,
  setPollTickHook,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/orbit/galaxy-poller";
import { resetState, setNotebookPath } from "../extensions/orbit/state";
import {
  setSubmissionLedger,
  submissionLedger,
  terminalEventKey,
} from "../extensions/orbit/submission-ledger";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const mockJob = vi.mocked(galaxyGetJobDetails);
const common = {
  galaxyServerUrl: "https://galaxy.test",
  notebookAnchor: "step-1",
  label: "fastqc",
  submittedAt: "2026-10-20T00:00:00Z",
  status: "in_progress" as const,
};
const jobDetails = (id: string, state: string) => ({ id, state, tool_id: "fastqc" });
const KEY = terminalEventKey("job", "job-1", "completed");

describe("the poller under the browser worker", () => {
  let dir: string;
  let nb: string;
  const notify = vi.fn();
  const resume = vi.fn();
  const statuses = (file = nb) => findJobBlocks(readFileSync(file, "utf8")).map((j) => j.status);

  beforeEach(() => {
    vi.resetAllMocks();
    setCapabilityProfile({ ...profileFromEnv({}), ui: "worker" });
    setSubmissionLedger(null);
    dir = mkdtempSync(join(tmpdir(), "loom-poller-worker-"));
    nb = join(dir, "notebook.md");
    setNotebookPath(nb);
    writeFileSync(nb, renderJobYaml({ ...common, jobId: "job-1" }));
    mockJob.mockImplementation(async (id) => jobDetails(id, "ok"));
  });

  afterEach(async () => {
    stopGalaxyPoller();
    await pollerIdle();
    vi.useRealTimers();
    setCaptureTickHook(null);
    setCapabilityProfile(null);
    setSubmissionLedger(null);
    resetState();
    rmSync(dir, { recursive: true, force: true });
  });

  it("arms no interval and fires no tick of its own", async () => {
    vi.useFakeTimers();
    startGalaxyPoller(notify, resume);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(mockJob).not.toHaveBeenCalled();
    expect(statuses()).toEqual(["in_progress"]);
  });

  it("reports a transition until the watch marks it delivered, and never resumes itself", async () => {
    startGalaxyPoller(notify, resume);
    const first = await pollGalaxyNow();
    expect(statuses()).toEqual(["completed"]);
    expect(first.transitions.map((t) => t.key)).toEqual([KEY]);
    expect(first.resumePrompt).toContain('"id": "job-1"');
    expect(first).toMatchObject({ inProgress: 0, pendingEnrichment: 0, openSubmissions: 0 });
    expect(resume).not.toHaveBeenCalled();
    expect(first.recordKey).toBe(nb);
    // The toast still goes out, and says the watch will follow up rather than that nobody will.
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("outputs require verification"),
      "info",
    );

    // Not delivered by the poller, so the next tick reports it again.
    expect((await pollGalaxyNow()).transitions.map((t) => t.key)).toEqual([KEY]);
    await submissionLedger().delivered(nb, [KEY]);
    const after = await pollGalaxyNow();
    expect(after.transitions).toEqual([]);
    expect(after.resumePrompt).toBeUndefined();
  });

  it("counts what is still in flight, waiting on enrichment, and sent but not captured", async () => {
    mockJob.mockImplementation(async (id) => jobDetails(id, "running"));
    writeFileSync(
      nb,
      [
        renderJobYaml({ ...common, jobId: "job-1" }),
        renderJobYaml({ ...common, jobId: "job-2", status: "completed", enrichment: "pending" }),
      ].join("\n"),
    );
    await submissionLedger().dispatched({
      callId: "call-1",
      attemptId: "att-1",
      toolName: "run_tool",
      recordKey: nb,
      stepAnchor: "step-1",
      server: "https://galaxy.test",
      dispatchedAt: new Date().toISOString(),
    });
    startGalaxyPoller(notify, resume);
    expect(await pollGalaxyNow()).toMatchObject({
      transitions: [],
      inProgress: 1,
      pendingEnrichment: 1,
      openSubmissions: 1,
    });
  });

  it("reports a record that is gone as quiet, so a watch over it can end", async () => {
    rmSync(nb);
    startGalaxyPoller(notify, resume);
    expect(await pollGalaxyNow()).toMatchObject({ recordKey: nb, inProgress: 0 });
  });

  it("captures an answered submission that has no block yet, and polls it in the same tick", async () => {
    writeFileSync(nb, "# Analysis\n");
    const ledger = submissionLedger();
    await ledger.dispatched({
      callId: "call-1",
      attemptId: "att-1",
      toolName: "run_tool",
      recordKey: nb,
      stepAnchor: "step-1",
      server: "https://galaxy.test",
      dispatchedAt: new Date().toISOString(),
    });
    await ledger.responded("call-1", {
      kind: "jobs",
      label: "fastqc",
      historyId: "hist-1",
      jobs: [{ jobId: "job-1" }],
    });
    startGalaxyPoller(notify, resume);
    expect(await pollGalaxyNow()).toMatchObject({ openSubmissions: 1 });
    expect(statuses()).toEqual([]);

    const recovered = await pollGalaxyNow({ recover: true });
    expect(statuses()).toEqual(["completed"]);
    expect(recovered).toMatchObject({ openSubmissions: 0, inProgress: 0 });
    expect(recovered.transitions.map((t) => t.key)).toEqual([KEY]);
  });

  it("waits for the capture hook when asked, and asks it for a reconcile", async () => {
    const seen: { reconcile: boolean; wait: boolean }[] = [];
    let release!: () => void;
    setCaptureTickHook(async (_n, options) => {
      seen.push(options);
      if (options.wait) await new Promise<void>((r) => (release = r));
    });
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    let done = false;
    const asked = pollGalaxyNow({ awaitEnrichment: true, reconcile: true }).then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(done).toBe(false);
    release();
    await asked;
    expect(seen).toEqual([
      { reconcile: false, wait: false },
      { reconcile: true, wait: true },
    ]);
  });

  it("a tick that spans a switch advances its own record and leaves the next session alone", async () => {
    let release!: () => void;
    mockJob.mockImplementation(
      (id) =>
        new Promise((r) => {
          release = () => r(jobDetails(id, "ok"));
        }) as never,
    );
    startGalaxyPoller(notify, resume);
    const stale = pollGalaxyNow();
    await vi.waitFor(() => expect(mockJob).toHaveBeenCalledOnce());

    // The worker switches conversations: another record, another poller.
    const nbB = join(dir, "b.md");
    writeFileSync(nbB, "# Analysis B\n");
    setNotebookPath(nbB);
    const notifyB = vi.fn();
    startGalaxyPoller(notifyB, vi.fn());
    release();
    expect((await stale).transitions).toEqual([]);

    expect(statuses()).toEqual(["completed"]);
    expect(readFileSync(nbB, "utf8")).toBe("# Analysis B\n");
    expect(notifyB).not.toHaveBeenCalled();
    expect((await submissionLedger().undelivered(nb)).map((e) => e.key)).toEqual([KEY]);

    // B's own tick: nothing of A's to report, and no block "gone missing" from B.
    expect((await pollGalaxyNow()).transitions).toEqual([]);
    expect(notifyB).not.toHaveBeenCalled();

    // Back on A, the transition the stale tick wrote is still there to deliver.
    setNotebookPath(nb);
    startGalaxyPoller(notify, resume);
    expect((await pollGalaxyNow()).transitions.map((t) => t.key)).toEqual([KEY]);
  });
});

describe("the poller on the desktop, across a switch to another record", () => {
  let dir: string;
  let nb: string;

  beforeEach(() => {
    vi.resetAllMocks();
    setSubmissionLedger(null);
    dir = mkdtempSync(join(tmpdir(), "loom-poller-switch-"));
    nb = join(dir, "notebook.md");
    setNotebookPath(nb);
    writeFileSync(nb, renderJobYaml({ ...common, jobId: "job-1" }));
  });

  afterEach(async () => {
    stopGalaxyPoller();
    await pollerIdle();
    setSubmissionLedger(null);
    resetState();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the stale tick's follow-up for its own record instead of dropping it", async () => {
    let release!: () => void;
    mockJob.mockImplementation(
      (id) =>
        new Promise((r) => {
          release = () => r(jobDetails(id, "ok"));
        }) as never,
    );
    const resume = vi.fn();
    startGalaxyPoller(vi.fn(), resume);
    await vi.waitFor(() => expect(mockJob).toHaveBeenCalledOnce());
    const nbB = join(dir, "b.md");
    writeFileSync(nbB, "# Analysis B\n");
    setNotebookPath(nbB);
    const notifyB = vi.fn();
    const resumeB = vi.fn();
    startGalaxyPoller(notifyB, resumeB);
    release();
    await pollerIdle();
    expect(statuses()).toEqual(["completed"]);
    expect(notifyB).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(resumeB).not.toHaveBeenCalled();
    expect((await submissionLedger().undelivered(nb)).map((e) => e.key)).toEqual([KEY]);
  });

  function statuses() {
    return findJobBlocks(readFileSync(nb, "utf8")).map((j) => j.status);
  }

  describe("a tick pinned to an unshown conversation's record", () => {
    let dir: string;
    let nb: string;
    let other: string;
    const notify = vi.fn();
    const resume = vi.fn();
    const statuses = (file: string) =>
      findJobBlocks(readFileSync(file, "utf8")).map((j) => j.status);
    afterEach(async () => {
      stopGalaxyPoller();
      await pollerIdle();
      setCapabilityProfile(null);
      setSubmissionLedger(null);
      resetState();
      rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(() => {
      vi.resetAllMocks();
      setCapabilityProfile({ ...profileFromEnv({}), ui: "worker" });
      setSubmissionLedger(null);
      dir = mkdtempSync(join(tmpdir(), "loom-poller-pinned-"));
      nb = join(dir, "notebook.md");
      setNotebookPath(nb);
      other = join(dir, "other.md");
      writeFileSync(other, renderJobYaml({ ...common, jobId: "job-9" }));
      writeFileSync(nb, renderJobYaml({ ...common, jobId: "job-1" }));
      mockJob.mockImplementation(async (id) => jobDetails(id, id === "job-9" ? "ok" : "running"));
    });

    it("moves that record's blocks but announces and delivers nothing until it's bound", async () => {
      startGalaxyPoller(notify, resume);
      const pinned = await pollGalaxyNow({ recordKey: other });
      expect(statuses(other)).toEqual(["completed"]);
      expect(statuses(nb)).toEqual(["in_progress"]);
      expect(pinned).toMatchObject({ recordKey: other, transitions: [], inProgress: 0 });
      expect(notify).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      // Bound again, its next tick hands over what the pinned one confirmed.
      setNotebookPath(other);
      const shown = await pollGalaxyNow();
      expect(shown.transitions.map((t) => t.key)).toEqual([
        terminalEventKey("job", "job-9", "completed"),
      ]);
    });

    it("feeds neither the panel nor capture, nor takes a turn of the bound record's reconcile", async () => {
      const panel = vi.fn(async () => {});
      const capture = vi.fn(async (_tick: number) => {});
      setPollTickHook(panel);
      setCaptureTickHook(capture);
      try {
        startGalaxyPoller(notify, resume);
        await pollGalaxyNow();
        const [before] = capture.mock.calls[0];
        await pollGalaxyNow({ recordKey: other });
        expect(panel).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledTimes(1);
        await pollGalaxyNow();
        expect(capture.mock.calls[1][0]).toBe(before + 1);
      } finally {
        setPollTickHook(null);
        setCaptureTickHook(null);
      }
    });

    it("isn't answered by a tick already running on the bound record", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      mockJob.mockImplementation(async (id) => {
        if (id === "job-1") await gate;
        return jobDetails(id, id === "job-9" ? "ok" : "running");
      });
      startGalaxyPoller(notify, resume);
      const bound = pollGalaxyNow();
      const pinned = pollGalaxyNow({ recordKey: other });
      release();
      expect((await bound).recordKey).toBe(nb);
      expect((await pinned).recordKey).toBe(other);
      expect(statuses(other)).toEqual(["completed"]);
    });

    it("leaves an unpinned caller to its own record rather than answering with the pinned one", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started = false;
      mockJob.mockImplementation(async (id) => {
        if (id === "job-9") {
          started = true;
          await gate;
        }
        return jobDetails(id, id === "job-9" ? "ok" : "running");
      });
      startGalaxyPoller(notify, resume);
      const pinned = pollGalaxyNow({ recordKey: other });
      await vi.waitFor(() => expect(started).toBe(true));
      const bound = pollGalaxyNow();
      release();
      expect((await pinned).recordKey).toBe(other);
      expect((await bound).recordKey).toBe(nb);
    });
  });
});
