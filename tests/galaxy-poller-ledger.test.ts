/**
 * The poller's terminal events (slice 3, decision 10): reserved before a block moves, confirmed
 * only once it has, so a transition is never announced for a write that didn't land and never
 * lost to a tick that died between the write and the follow-up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../extensions/orbit/galaxy-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/orbit/galaxy-api.js")>()),
  getGalaxyConfig: vi.fn(() => ({ url: "https://galaxy.test", apiKey: "k" })),
  galaxyGetInvocation: vi.fn(),
  galaxyGetJobDetails: vi.fn(),
}));

import { galaxyGetInvocation, galaxyGetJobDetails } from "../extensions/orbit/galaxy-api.js";
import { findJobBlocks, renderJobYaml } from "../extensions/orbit/galaxy-job-block";
import {
  pollGalaxyNow,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/orbit/galaxy-poller";
import { findInvocationBlocks, renderInvocationYaml } from "../extensions/orbit/notebook-writer";
import { setRecordStore, type RecordStore } from "../extensions/orbit/record-store";
import { createFileRecordStore } from "../extensions/orbit/record-store-file";
import { resetState, setNotebookPath } from "../extensions/orbit/state";
import {
  createMemoryLedger,
  setSubmissionLedger,
  submissionLedger,
  terminalEventKey,
} from "../extensions/orbit/submission-ledger";
import { checkInvocations } from "../extensions/orbit/tools";

const mockJob = vi.mocked(galaxyGetJobDetails);
const mockInv = vi.mocked(galaxyGetInvocation);
const common = {
  galaxyServerUrl: "https://galaxy.test",
  notebookAnchor: "step-1",
  label: "fastqc",
  submittedAt: "2026-10-20T00:00:00Z",
  status: "in_progress" as const,
};
const jobDetails = (id: string, state: string) => ({ id, state, tool_id: "fastqc" });
const invocationDetails = (states: string[]) => ({
  id: "inv-1",
  state: "scheduled",
  workflow_id: "wf-1",
  history_id: "hist-1",
  steps: [
    {
      id: "s1",
      order_index: 0,
      state: null,
      jobs: states.map((s, i) => ({ id: `wj-${i}`, state: s, tool_id: "fastqc" })),
    },
  ],
});
const KEY = terminalEventKey("job", "job-1", "completed");

describe("terminal events", () => {
  let dir: string;
  let nb: string;
  const notify = vi.fn();
  const resume = vi.fn();
  const blocks = () => findJobBlocks(readFileSync(nb, "utf8"));
  const statuses = () => blocks().map((j) => j.status);

  beforeEach(() => {
    vi.resetAllMocks();
    setSubmissionLedger(null);
    dir = mkdtempSync(join(tmpdir(), "loom-poller-ledger-"));
    nb = join(dir, "notebook.md");
    setNotebookPath(nb);
    writeFileSync(nb, renderJobYaml({ ...common, jobId: "job-1" }));
    mockJob.mockImplementation(async (id) => jobDetails(id, "ok"));
  });

  afterEach(() => {
    stopGalaxyPoller();
    setRecordStore(null);
    setSubmissionLedger(null);
    resetState();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A file store for the notebook whose writes go through `write` instead. */
  function storeWith(
    write: (real: RecordStore["write"], ...args: Parameters<RecordStore["write"]>) => Promise<void>,
  ) {
    const file = createFileRecordStore(nb);
    setRecordStore({ ...file, write: (content, expect) => write(file.write, content, expect) });
  }

  it("delivers a finished job once, and leaves nothing in the ledger", async () => {
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledOnce();
    expect(statuses()).toEqual(["completed"]);
    expect(await submissionLedger().reserved(nb)).toEqual([]);
    expect(await submissionLedger().undelivered(nb)).toEqual([]);
  });

  it("announces nothing for a block deleted while its status was being read", async () => {
    mockJob.mockImplementation(async (id) => {
      writeFileSync(nb, "# Analysis\n");
      return jobDetails(id, "ok");
    });
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).not.toHaveBeenCalled();
    expect(await submissionLedger().reserved(nb)).toEqual([]);
    expect(await submissionLedger().undelivered(nb)).toEqual([]);
  });

  it("announces nothing for a block another writer moved first", async () => {
    // galaxy_job_record, say, marking it finished while the poll was out.
    mockJob.mockImplementation(async (id) => {
      writeFileSync(nb, renderJobYaml({ ...common, jobId: "job-1", status: "completed" }));
      return jobDetails(id, "ok");
    });
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).not.toHaveBeenCalled();
    expect(await submissionLedger().reserved(nb)).toEqual([]);
    expect(await submissionLedger().undelivered(nb)).toEqual([]);
  });

  it("a tick that dies after the write leaves the transition for the next poller to deliver", async () => {
    let die = true;
    storeWith(async (real, content, expect) => {
      await real(content, expect);
      if (die) throw new Error("worker gone");
    });
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    // Persisted, not announced: today that transition was lost for good.
    expect(statuses()).toEqual(["completed"]);
    expect(resume).not.toHaveBeenCalled();
    expect((await submissionLedger().reserved(nb)).map((e) => e.key)).toEqual([KEY]);

    die = false;
    stopGalaxyPoller();
    const next = vi.fn();
    startGalaxyPoller(notify, next);
    await pollGalaxyNow();
    await pollGalaxyNow();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toContain('"id": "job-1"');
    expect(await submissionLedger().reserved(nb)).toEqual([]);
    expect(await submissionLedger().undelivered(nb)).toEqual([]);
  });

  it("a tick that dies before the write keeps the reservation for the real transition to reuse", async () => {
    let die = true;
    storeWith(async (real, content, expect) => {
      if (die) throw new Error("worker gone");
      await real(content, expect);
    });
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(statuses()).toEqual(["in_progress"]);
    expect((await submissionLedger().reserved(nb)).map((e) => e.key)).toEqual([KEY]);

    die = false;
    await pollGalaxyNow();
    expect(statuses()).toEqual(["completed"]);
    expect(resume).toHaveBeenCalledOnce();
    expect(await submissionLedger().reserved(nb)).toEqual([]);
  });

  it("a reservation whose block ended some other way is voided, not announced", async () => {
    await submissionLedger().reserve({
      recordKey: nb,
      kind: "job",
      id: "job-1",
      from: "in_progress",
      to: "completed",
      outcome: "completed",
      label: "fastqc",
      key: KEY,
    });
    writeFileSync(nb, renderJobYaml({ ...common, jobId: "job-1", status: "cancelled" }));
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).not.toHaveBeenCalled();
    expect(await submissionLedger().reserved(nb)).toEqual([]);
  });

  it("delivers a finished workflow through the ledger, and the model's own check reserves nothing", async () => {
    writeFileSync(nb, renderInvocationYaml({ ...common, invocationId: "inv-1" }));
    mockInv.mockResolvedValue(invocationDetails(["ok"]) as never);
    await checkInvocations(undefined);
    expect(await submissionLedger().reserved(nb)).toEqual([]);
    expect(await submissionLedger().undelivered(nb)).toEqual([]);

    writeFileSync(nb, renderInvocationYaml({ ...common, invocationId: "inv-1" }));
    startGalaxyPoller(notify, resume);
    await pollGalaxyNow();
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0][0]).toContain('"outcome": "completed"');
    expect(await submissionLedger().undelivered(nb)).toEqual([]);
  });

  describe("for a workflow", () => {
    const INV_KEY = terminalEventKey("invocation", "inv-1", "completed");
    const invStatus = () => findInvocationBlocks(readFileSync(nb, "utf8")).map((b) => b.status);
    beforeEach(() => {
      writeFileSync(nb, renderInvocationYaml({ ...common, invocationId: "inv-1" }));
      mockInv.mockResolvedValue(invocationDetails(["ok"]) as never);
    });

    it("announces nothing for a block deleted while its status was being read", async () => {
      mockInv.mockImplementation((async () => {
        writeFileSync(nb, "# Analysis\n");
        return invocationDetails(["ok"]);
      }) as never);
      startGalaxyPoller(notify, resume);
      await pollGalaxyNow();
      expect(resume).not.toHaveBeenCalled();
      expect(await submissionLedger().reserved(nb)).toEqual([]);
      expect(await submissionLedger().undelivered(nb)).toEqual([]);
    });

    it("a tick that dies after the write leaves the transition for the next tick", async () => {
      let die = true;
      storeWith(async (real, content, expect) => {
        await real(content, expect);
        if (die) throw new Error("worker gone");
      });
      startGalaxyPoller(notify, resume);
      await pollGalaxyNow();
      expect(invStatus()).toEqual(["completed"]);
      expect(resume).not.toHaveBeenCalled();
      expect((await submissionLedger().reserved(nb)).map((e) => e.key)).toEqual([INV_KEY]);

      die = false;
      await pollGalaxyNow();
      await pollGalaxyNow();
      expect(resume).toHaveBeenCalledOnce();
      expect(resume.mock.calls[0][0]).toContain('"id": "inv-1"');
    });

    it("moves no block whose event the ledger can't take", async () => {
      setSubmissionLedger({
        ...createMemoryLedger(),
        reserve: async () => {
          throw new Error("ledger unavailable");
        },
      });
      writeFileSync(
        nb,
        [
          renderJobYaml({ ...common, jobId: "job-1" }),
          renderInvocationYaml({ ...common, invocationId: "inv-1" }),
        ].join("\n"),
      );
      startGalaxyPoller(notify, resume);
      await pollGalaxyNow();
      expect(statuses()).toEqual(["in_progress"]);
      expect(invStatus()).toEqual(["in_progress"]);
      expect(resume).not.toHaveBeenCalled();
    });
  });
});
