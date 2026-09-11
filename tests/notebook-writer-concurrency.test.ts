import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  writeNotebook,
  readNotebook,
  withNotebookLock,
  upsertInvocationBlock,
  applyInvocationUpdates,
  findInvocationBlocks,
  statNotebook,
  NotebookChangedError,
  renderInvocationYaml,
  type InvocationYaml,
  type InvocationPollUpdate,
} from "../extensions/loom/notebook-writer";

describe("writeNotebook + withNotebookLock", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-concurrency-"));
    nbPath = join(dir, "notebook.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeNotebook is atomic (no scratch file left behind on success)", async () => {
    await writeNotebook(nbPath, "hello\n");
    expect(readFileSync(nbPath, "utf-8")).toBe("hello\n");
    // Scratch file shouldn't survive; rename should have moved it.
    expect(readdirSync(dir)).toEqual(["notebook.md"]);
  });

  it("two parallel upsert+write cycles serialize via the lock — neither update is lost", async () => {
    await writeNotebook(nbPath, "");

    const invA: InvocationYaml = {
      invocationId: "inv-A",
      galaxyServerUrl: "https://x.org",
      notebookAnchor: "plan-1-step-1",
      label: "A",
      submittedAt: "2026-04-25T00:00:00Z",
      status: "in_progress",
    };
    const invB: InvocationYaml = {
      invocationId: "inv-B",
      galaxyServerUrl: "https://x.org",
      notebookAnchor: "plan-1-step-2",
      label: "B",
      submittedAt: "2026-04-25T00:00:01Z",
      status: "in_progress",
    };

    // Race two read-modify-write cycles. Without the lock they would both
    // read the empty file, each writes its own block, the second overwrites
    // the first → only one block survives.
    const work = (inv: InvocationYaml) =>
      withNotebookLock(nbPath, async () => {
        const content = await readNotebook(nbPath);
        await new Promise((r) => setTimeout(r, 5)); // amplify race window
        const updated = upsertInvocationBlock(content, inv);
        await writeNotebook(nbPath, updated);
      });

    await Promise.all([work(invA), work(invB)]);

    const final = readFileSync(nbPath, "utf-8");
    expect(final).toContain("invocation_id: inv-A");
    expect(final).toContain("invocation_id: inv-B");
  });

  it("lock releases even if work() throws", async () => {
    await writeNotebook(nbPath, "init\n");

    let secondRan = false;
    const failing = withNotebookLock(nbPath, async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    await withNotebookLock(nbPath, async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
  });
});

describe("writeNotebook staleness guard", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-stale-"));
    nbPath = join(dir, "notebook.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes when the file is untouched since the stamp was taken", async () => {
    await writeNotebook(nbPath, "one\n");
    const stamp = await statNotebook(nbPath);
    await writeNotebook(nbPath, "two\n", stamp ?? undefined);
    expect(readFileSync(nbPath, "utf-8")).toBe("two\n");
  });

  it("refuses the write, and leaves the file and tmp alone, when the file changed", async () => {
    await writeNotebook(nbPath, "one\n");
    const stamp = await statNotebook(nbPath);
    appendFileSync(nbPath, "appended out of band\n", "utf-8");

    await expect(writeNotebook(nbPath, "clobber\n", stamp ?? undefined)).rejects.toBeInstanceOf(
      NotebookChangedError,
    );
    expect(readFileSync(nbPath, "utf-8")).toBe("one\nappended out of band\n");
    // The abandoned staging file is cleaned up, not orphaned next to the notebook.
    expect(readdirSync(dir)).toEqual(["notebook.md"]);
  });

  it("refuses the write when the file was deleted under us", async () => {
    await writeNotebook(nbPath, "one\n");
    const stamp = await statNotebook(nbPath);
    rmSync(nbPath);

    await expect(writeNotebook(nbPath, "recreated\n", stamp ?? undefined)).rejects.toBeInstanceOf(
      NotebookChangedError,
    );
    expect(() => readFileSync(nbPath, "utf-8")).toThrow();
  });

  it("skips the guard entirely when no stamp is supplied", async () => {
    await writeNotebook(nbPath, "one\n");
    appendFileSync(nbPath, "appended\n", "utf-8");
    await writeNotebook(nbPath, "unguarded\n");
    expect(readFileSync(nbPath, "utf-8")).toBe("unguarded\n");
  });

  it("stages each write separately, so overlapping writes can't blend", async () => {
    // A shared scratch path would let one writer rename the other's bytes, or
    // delete a staging file still in use. Both payloads are the same length, so
    // a torn result would show up as a mix rather than a length mismatch.
    const a = "a".repeat(4096);
    const b = "b".repeat(4096);
    await writeNotebook(nbPath, "seed\n");

    await Promise.all([writeNotebook(nbPath, a), writeNotebook(nbPath, b)]);

    const final = readFileSync(nbPath, "utf-8");
    expect([a, b]).toContain(final);
    expect(readdirSync(dir)).toEqual(["notebook.md"]);
  });

  it("statNotebook returns null for a missing file", async () => {
    expect(await statNotebook(join(dir, "nope.md"))).toBeNull();
  });
});

describe("applyInvocationUpdates", () => {
  const base: InvocationYaml = {
    invocationId: "inv-1",
    galaxyServerUrl: "https://x.org",
    notebookAnchor: "plan-1-step-1",
    label: "A",
    submittedAt: "2026-04-25T00:00:00Z",
    status: "in_progress",
  };

  function poll(overrides: Partial<InvocationPollUpdate> = {}): InvocationPollUpdate {
    return {
      invocationId: "inv-1",
      totalSteps: 2,
      completedSteps: 1,
      totalJobs: 4,
      completedJobs: 2,
      failedJobs: 0,
      lastPolledAt: "2026-04-25T01:00:00Z",
      ...overrides,
    };
  }

  it("applies an update in place against the supplied content", () => {
    const content = `# Notes\n\n${renderInvocationYaml(base)}`;
    const {
      content: next,
      applied,
      transitioned,
    } = applyInvocationUpdates(content, [
      poll({ transition: { status: "completed", summary: "all done" } }),
    ]);
    expect(applied).toEqual(["inv-1"]);
    expect(transitioned).toEqual(["inv-1"]);
    expect(next).toContain("status: completed");
    expect(next).toContain("summary: all done");
    expect(next).toContain("completed_jobs: 2");
    expect(next).toContain("# Notes");
  });

  it("re-stating the status the block already has is a refresh, not a transition", () => {
    const onDisk = renderInvocationYaml({
      ...base,
      status: "completed",
      summary: "Workflow completed: 2 jobs succeeded",
      lastPolledAt: "2026-04-25T00:30:00Z",
    });
    const { content, applied, transitioned } = applyInvocationUpdates(onDisk, [
      poll({
        transition: { status: "completed", summary: "Workflow completed: 2 jobs succeeded" },
      }),
    ]);
    expect(applied).toEqual(["inv-1"]);
    expect(transitioned).toEqual([]);
    const block = findInvocationBlocks(content)[0];
    expect(block.status).toBe("completed");
    expect(block.completedJobs).toBe(2);
    expect(block.lastPolledAt).toBe("2026-04-25T01:00:00Z");
  });

  it("lets a later poll correct one terminal state to another", () => {
    // Completion is inferred from the jobs Galaxy has materialized, so a poll
    // that lands mid-schedule can call a workflow done before its failing step
    // exists. The correction has to get through — and be announced.
    const onDisk = renderInvocationYaml({
      ...base,
      status: "completed",
      summary: "Workflow completed: 2 jobs succeeded",
    });
    const { content, transitioned } = applyInvocationUpdates(onDisk, [
      poll({
        failedJobs: 1,
        transition: { status: "failed", summary: "Workflow failed: 1 job(s) errored" },
      }),
    ]);
    expect(transitioned).toEqual(["inv-1"]);
    const block = findInvocationBlocks(content)[0];
    // The status and the counters must not disagree.
    expect(block.status).toBe("failed");
    expect(block.failedJobs).toBe(1);
    expect(block.summary).toBe("Workflow failed: 1 job(s) errored");
  });

  it("keeps the fields the poller doesn't own", () => {
    // The block on disk is the agent's version, not the one the poll started from.
    const onDisk = renderInvocationYaml({
      ...base,
      label: "Renamed by the agent",
      notebookAnchor: "plan-2-step-9",
      summary: "hand-written note",
    });
    const { content } = applyInvocationUpdates(onDisk, [poll()]);
    const block = findInvocationBlocks(content)[0];
    expect(block.label).toBe("Renamed by the agent");
    expect(block.notebookAnchor).toBe("plan-2-step-9");
    expect(block.summary).toBe("hand-written note");
    expect(block.status).toBe("in_progress");
    expect(block.completedJobs).toBe(2);
  });

  it("overwrites status and summary only on a transition", () => {
    const onDisk = renderInvocationYaml({ ...base, summary: "hand-written note" });
    const { content } = applyInvocationUpdates(onDisk, [
      poll({ transition: { status: "failed", summary: "Workflow failed: 1 job(s) errored" } }),
    ]);
    const block = findInvocationBlocks(content)[0];
    expect(block.status).toBe("failed");
    expect(block.summary).toBe("Workflow failed: 1 job(s) errored");
  });

  it("skips a block that is no longer in the content", () => {
    const { content, applied } = applyInvocationUpdates("# Notes\n\nnothing here\n", [poll()]);
    expect(applied).toEqual([]);
    expect(content).toBe("# Notes\n\nnothing here\n");
  });

  it("skips an update older than the poll already recorded on disk", () => {
    const onDisk = renderInvocationYaml({
      ...base,
      status: "completed",
      lastPolledAt: "2026-04-25T02:00:00Z",
    });
    const { content, applied } = applyInvocationUpdates(onDisk, [
      poll({ lastPolledAt: "2026-04-25T01:00:00Z" }),
    ]);
    expect(applied).toEqual([]);
    expect(content).toBe(onDisk);
    expect(content).toContain("status: completed");
  });

  it("ignores a last_polled_at further ahead than any clock could be", () => {
    // A model that writes itself a future timestamp would otherwise silence the
    // poller for this invocation permanently: every later update reads as stale.
    const onDisk = renderInvocationYaml({
      ...base,
      lastPolledAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const { content, applied, transitioned } = applyInvocationUpdates(onDisk, [
      poll({
        lastPolledAt: new Date().toISOString(),
        transition: { status: "completed", summary: "all done" },
      }),
    ]);
    expect(applied).toEqual(["inv-1"]);
    expect(transitioned).toEqual(["inv-1"]);
    expect(content).toContain("status: completed");
  });

  it("still yields to a competing poller whose clock runs slightly ahead", () => {
    const onDisk = renderInvocationYaml({
      ...base,
      status: "completed",
      lastPolledAt: new Date(Date.now() + 5_000).toISOString(),
    });
    const { applied } = applyInvocationUpdates(onDisk, [
      poll({ lastPolledAt: new Date().toISOString() }),
    ]);
    expect(applied).toEqual([]);
  });

  it("refuses to reopen a block another checker already finished", () => {
    // The "a job failed while others run" verdict writes in_progress on
    // purpose. Delivered late -- after a faster checker recorded the real end
    // -- it would walk a terminal block back to running, and the next poll
    // would announce the failure all over again.
    const onDisk = renderInvocationYaml({
      ...base,
      status: "failed",
      summary: "Workflow failed: 1 job(s) errored, 1 succeeded",
    });
    const { content, applied } = applyInvocationUpdates(onDisk, [
      poll({
        failedJobs: 1,
        transition: {
          status: "in_progress",
          summary: "Workflow in progress: 1 job(s) failed, 1 still running",
        },
      }),
    ]);
    expect(applied).toEqual([]);
    expect(content).toBe(onDisk);
  });

  it("still writes an in_progress summary onto a block that is still running", () => {
    const { content, applied, transitioned } = applyInvocationUpdates(renderInvocationYaml(base), [
      poll({
        failedJobs: 1,
        transition: {
          status: "in_progress",
          summary: "Workflow in progress: 1 job(s) failed, 1 still running",
        },
      }),
    ]);
    expect(applied).toEqual(["inv-1"]);
    expect(transitioned).toEqual([]);
    expect(content).toContain("1 job(s) failed, 1 still running");
  });

  it("applies when the block on disk has never been polled", () => {
    const { applied } = applyInvocationUpdates(renderInvocationYaml(base), [poll()]);
    expect(applied).toEqual(["inv-1"]);
  });

  it("reports only the ids it wrote when a batch is partly skipped", () => {
    const other: InvocationYaml = { ...base, invocationId: "inv-2", notebookAnchor: "plan-1-s2" };
    const onDisk = `${renderInvocationYaml(base)}\n${renderInvocationYaml(other)}`;
    const { applied } = applyInvocationUpdates(onDisk, [
      poll(),
      poll({ invocationId: "inv-gone" }),
      poll({ invocationId: "inv-2" }),
    ]);
    expect(applied).toEqual(["inv-1", "inv-2"]);
  });
});
