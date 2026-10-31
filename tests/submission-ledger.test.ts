/**
 * The submission ledger (slice 3, decision 10): written around every Galaxy submission from inside
 * the tool's execute, read by capture's recovery and by reconcile. The poller's terminal events
 * are in galaxy-poller-ledger.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setGalaxyTransport } from "../extensions/orbit/galaxy-api";
import { findJobBlocks } from "../extensions/orbit/galaxy-job-block";
import { listAttemptRecords } from "../extensions/orbit/galaxy-provenance";
import { resetReconcileState, runReconcile } from "../extensions/orbit/galaxy-reconcile";
import {
  handleSubmissionResult,
  pinnedDispatch,
  recoverSubmissions,
  registerSubmissionCapture,
  resetSubmissionCapture,
} from "../extensions/orbit/galaxy-submission-capture";
import { GALAXY_DEADLINE_MS } from "../extensions/orbit/galaxy-tool-wrap";
import { NotebookChangedError, setRecordStore } from "../extensions/orbit/record-store";
import { createFileRecordStore } from "../extensions/orbit/record-store-file";
import { resetState, setNotebookPath } from "../extensions/orbit/state";
import {
  createMemoryLedger,
  setSubmissionLedger,
  submissionLedger,
  terminalEventKey,
  type LedgerState,
  type SubmissionLedger,
} from "../extensions/orbit/submission-ledger";
import { GALAXY } from "./galaxy-family-fixture";
import { CREDENTIALS, guardHooks, json, recordGalaxy, runOp } from "./galaxy-test-helpers";

const SERVER = CREDENTIALS().url;
const HISTORY = "bbbb000000000002";
const JOB = "aaaa000000000001";
const UPLOAD = { url: "https://data.test/reads.fq", history_id: HISTORY };
const accepted = () =>
  json({ jobs: [{ id: JOB, tool_id: "__DATA_FETCH__", history_id: HISTORY }], outputs: [] });

let dirs: string[] = [];
function analysis(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ledger-"));
  dirs.push(dir);
  const nb = path.join(dir, "notebook.md");
  fs.writeFileSync(nb, "# Analysis\n");
  return nb;
}

beforeEach(() => {
  resetState();
  resetSubmissionCapture();
  resetReconcileState();
  setSubmissionLedger(null);
});

afterEach(() => {
  setGalaxyTransport(null);
  setRecordStore(null);
  setSubmissionLedger(null);
  resetState();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("the memory ledger", () => {
  const entry = (callId: string, recordKey = "/a/notebook.md") => ({
    callId,
    attemptId: `att-${callId}`,
    toolName: "run_tool",
    recordKey,
    stepAnchor: "step-1",
    historyId: HISTORY,
    server: SERVER,
    dispatchedAt: "2026-10-20T10:00:00.000Z",
  });
  const event = (id: string, outcome = "completed", recordKey = "/a/notebook.md") => ({
    recordKey,
    kind: "job" as const,
    id,
    from: "in_progress",
    to: outcome === "failing" ? "in_progress" : outcome,
    outcome,
    label: id,
    key: terminalEventKey("job", id, outcome),
  });

  it("keeps an entry open until it is captured, reconciled or abandoned, then forgets it", async () => {
    const ledger = createMemoryLedger();
    for (const id of ["c1", "c2", "c3"]) await ledger.dispatched(entry(id));
    await ledger.dispatched(entry("other", "/b/notebook.md"));
    await ledger.responded("c1", {
      kind: "jobs",
      label: "x",
      historyId: HISTORY,
      jobs: [{ jobId: JOB }],
    });
    expect((await ledger.open("/a/notebook.md")).map((e) => [e.callId, e.state])).toEqual([
      ["c1", "responded"],
      ["c2", "dispatched"],
      ["c3", "dispatched"],
    ]);
    await ledger.captured("c1");
    await ledger.reconciled("c2", "looked");
    await ledger.abandoned("c3", "unparsed");
    expect(await ledger.open("/a/notebook.md")).toEqual([]);
    expect(await ledger.open("/b/notebook.md")).toHaveLength(1);
    // The history outlives the entries it came from.
    expect(await ledger.lastHistory("/a/notebook.md")).toEqual({
      historyId: HISTORY,
      server: SERVER,
    });
  });

  it("takes no history from a call Galaxy never answered", async () => {
    const ledger = createMemoryLedger();
    await ledger.dispatched({ ...entry("refused"), historyId: "dddd000000000004" });
    await ledger.abandoned("refused", "404");
    expect(await ledger.lastHistory("/a/notebook.md")).toBeUndefined();
  });

  it("ignores a call it has no entry for", async () => {
    const ledger = createMemoryLedger();
    await ledger.responded("ghost", { kind: "jobs", label: "x" });
    await ledger.captured("ghost");
    await ledger.abandoned("ghost", "why");
    expect(await ledger.open("/a/notebook.md")).toEqual([]);
  });

  it("reserves once per key, delivers only what was confirmed, and drops what was voided", async () => {
    const ledger = createMemoryLedger();
    await ledger.reserve(event("j1"));
    await ledger.reserve({ ...event("j1"), label: "again" });
    await ledger.reserve(event("j2"));
    expect((await ledger.reserved("/a/notebook.md")).map((e) => e.label)).toEqual(["j1", "j2"]);
    expect(await ledger.undelivered("/a/notebook.md")).toEqual([]);
    await ledger.confirm("/a/notebook.md", event("j1").key);
    await ledger.void("/a/notebook.md", event("j2").key);
    expect((await ledger.undelivered("/a/notebook.md")).map((e) => e.id)).toEqual(["j1"]);
    expect(await ledger.reserved("/a/notebook.md")).toEqual([]);
    await ledger.delivered("/a/notebook.md", [event("j1").key]);
    expect(await ledger.undelivered("/a/notebook.md")).toEqual([]);
    // A voided key can be reserved again by a later, real transition.
    await ledger.reserve(event("j2"));
    expect(await ledger.reserved("/a/notebook.md")).toHaveLength(1);
  });

  it("as a durable ledger, comes back from what it last wrote down", async () => {
    let disk: LedgerState | undefined;
    const persist = async (state: LedgerState) => void (disk = JSON.parse(JSON.stringify(state)));
    const first = createMemoryLedger({ persist });
    await first.dispatched(entry("c1"));
    await first.dispatched(entry("c2"));
    await first.responded("c1", {
      kind: "jobs",
      label: "x",
      historyId: HISTORY,
      jobs: [{ jobId: JOB }],
    });
    await first.captured("c2");
    await first.reserve(event("j1"));
    await first.confirm("/a/notebook.md", event("j1").key);
    await first.reserve(event("j2"));

    const reopened = createMemoryLedger({ state: disk, persist });
    expect((await reopened.open("/a/notebook.md")).map((e) => [e.callId, e.state])).toEqual([
      ["c1", "responded"],
    ]);
    expect((await reopened.undelivered("/a/notebook.md")).map((e) => e.id)).toEqual(["j1"]);
    expect((await reopened.reserved("/a/notebook.md")).map((e) => e.id)).toEqual(["j2"]);
    expect(await reopened.lastHistory("/a/notebook.md")).toEqual({
      historyId: HISTORY,
      server: SERVER,
    });
  });

  it("as a durable ledger, returns from dispatched only once the entry is written, and fails with the write", async () => {
    let release!: () => void;
    let fail = false;
    const ledger = createMemoryLedger({
      persist: () =>
        fail
          ? Promise.reject(new Error("quota exceeded"))
          : new Promise<void>((r) => (release = r)),
    });
    let done = false;
    const pending = ledger.dispatched(entry("c1")).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    release();
    await pending;
    fail = true;
    // A submission whose entry can't be written down is stopped before its request goes out,
    // and leaves no entry behind to hold the record open.
    await expect(ledger.dispatched(entry("c2"))).rejects.toThrow("quota exceeded");
    expect((await ledger.open("/a/notebook.md")).map((e) => e.callId)).toEqual(["c1"]);
  });

  it("remembers a delivered mid-flight failure, so the next tick can't announce it again", async () => {
    const ledger = createMemoryLedger();
    const failing = event("inv-1", "failing");
    await ledger.reserve(failing);
    await ledger.confirm(failing.recordKey, failing.key);
    await ledger.delivered(failing.recordKey, [failing.key]);
    await ledger.reserve(failing);
    expect(await ledger.reserved(failing.recordKey)).toEqual([]);
    expect(await ledger.undelivered(failing.recordKey)).toEqual([]);
  });
});

describe("a submission's execute", () => {
  it("writes nothing to Galaxy when the ledger entry can't be written first", async () => {
    setNotebookPath(analysis());
    const failing: SubmissionLedger = {
      ...createMemoryLedger(),
      dispatched: async () => {
        throw new Error("disk full");
      },
    };
    setSubmissionLedger(failing);
    const seen = recordGalaxy(accepted);
    const result = await runOp("upload_file_from_url", UPLOAD);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Not sent to Galaxy.*disk full/);
    expect(seen).toEqual([]);
  });

  it("records the call before sending and Galaxy's answer after, under the record it started in", async () => {
    const a = analysis();
    const b = analysis();
    setNotebookPath(a);
    const fire = guardHooks(registerSubmissionCapture, GALAXY);
    await fire("tool_execution_start", {
      toolCallId: "call-1",
      toolName: "upload_file_from_url",
      args: UPLOAD,
    });
    const pinned = pinnedDispatch("call-1")!;
    // The user moves to another analysis between the call starting and its request going out.
    setNotebookPath(b);
    let atSend: unknown[] = [];
    recordGalaxy(async () => {
      atSend = await submissionLedger().open(a);
      return accepted();
    });
    const result = await runOp("upload_file_from_url", UPLOAD);

    expect(atSend).toMatchObject([
      { callId: "call-1", state: "dispatched", attemptId: pinned.attemptId, historyId: HISTORY },
    ]);
    expect(await submissionLedger().open(b)).toEqual([]);
    expect(await submissionLedger().open(a)).toMatchObject([
      { state: "responded", submission: { jobs: [{ jobId: JOB }] } },
    ]);

    // Capture writes to the same record, and closes the entry.
    await fire("tool_execution_end", {
      toolCallId: "call-1",
      toolName: "upload_file_from_url",
      result,
      isError: false,
    });
    expect(findJobBlocks(fs.readFileSync(a, "utf-8")).map((j) => j.jobId)).toEqual([JOB]);
    expect(findJobBlocks(fs.readFileSync(b, "utf-8"))).toEqual([]);
    expect(await submissionLedger().open(a)).toEqual([]);
  });

  it("with no start event, files the call under the record bound when it is sent", async () => {
    const a = analysis();
    setNotebookPath(a);
    let atSend: unknown[] = [];
    recordGalaxy(async () => {
      atSend = await submissionLedger().open(a);
      return accepted();
    });
    await runOp("upload_file_from_url", UPLOAD);
    expect(atSend).toMatchObject([{ callId: "call-1", stepAnchor: "unattributed" }]);
  });

  it("closes the entry when Galaxy refuses, and keeps it open when the answer may have been lost", async () => {
    const refused = analysis();
    setNotebookPath(refused);
    recordGalaxy(() => json({ err_msg: "no such history" }, 404));
    await runOp("upload_file_from_url", UPLOAD);
    expect(await submissionLedger().open(refused)).toEqual([]);
    const nb = analysis();
    setNotebookPath(nb);
    recordGalaxy(() => {
      throw new TypeError("fetch failed");
    });
    await runOp("upload_file_from_url", UPLOAD);
    expect(await submissionLedger().open(nb)).toMatchObject([{ state: "dispatched" }]);
  });
});

describe("capture's side of the ledger", () => {
  async function respond(nb: string, callId = "call-1") {
    setNotebookPath(nb);
    const fire = guardHooks(registerSubmissionCapture, GALAXY);
    await fire("tool_execution_start", {
      toolCallId: callId,
      toolName: "upload_file_from_url",
      args: UPLOAD,
    });
    recordGalaxy(accepted);
    const result = await runOp("upload_file_from_url", UPLOAD);
    return { fire, result };
  }

  it("abandons an entry whose record write lost three races", async () => {
    const nb = analysis();
    const file = createFileRecordStore(nb);
    setRecordStore({
      ...file,
      write: async () => {
        throw new NotebookChangedError(nb);
      },
    });
    const { fire, result } = await respond(nb);
    await fire("tool_execution_end", {
      toolCallId: "call-1",
      toolName: "upload_file_from_url",
      result,
      isError: false,
    });
    expect(await submissionLedger().open(nb)).toEqual([]);
    expect(findJobBlocks(fs.readFileSync(nb, "utf-8"))).toEqual([]);
  });

  it("abandons an entry whose answer can't be read", async () => {
    const nb = analysis();
    setNotebookPath(nb);
    await submissionLedger().dispatched({
      callId: "call-9",
      attemptId: "att",
      toolName: "run_tool",
      recordKey: nb,
      stepAnchor: "unattributed",
      server: SERVER,
      dispatchedAt: new Date().toISOString(),
    });
    await handleSubmissionResult(
      "call-9",
      "run_tool",
      { content: [{ type: "text", text: "?" }] },
      false,
    );
    expect(await submissionLedger().open(nb)).toEqual([]);
  });

  it("recovers a submission whose end event never came, into the record it was made in", async () => {
    const a = analysis();
    const b = analysis();
    await respond(a);
    // The conversation was left; another is bound, with its own store installed.
    setNotebookPath(b);
    setRecordStore(createFileRecordStore(b));
    expect(await recoverSubmissions(a)).toBe(1);

    expect(findJobBlocks(fs.readFileSync(a, "utf-8")).map((j) => j.jobId)).toEqual([JOB]);
    expect(findJobBlocks(fs.readFileSync(b, "utf-8"))).toEqual([]);
    const records = await listAttemptRecords(path.dirname(a));
    expect(records.map((r) => [r.origin, r.submitted_by, r.ids.job_ids])).toEqual([
      ["submission", "harness", [JOB]],
    ]);
    expect(await submissionLedger().open(a)).toEqual([]);
    // Recovered once: running it again, or the end event arriving late, writes nothing more.
    expect(await recoverSubmissions(a)).toBe(0);
  });

  it("after a reload, recovers from the ledger alone", async () => {
    const a = analysis();
    await respond(a);
    const ledger = submissionLedger();

    vi.resetModules();
    const fresh = await import("../extensions/orbit/galaxy-submission-capture");
    const freshLedger = await import("../extensions/orbit/submission-ledger");
    const freshState = await import("../extensions/orbit/state");
    freshLedger.setSubmissionLedger(ledger);
    freshState.setNotebookPath(analysis());

    expect(await fresh.recoverSubmissions(a)).toBe(1);
    const [block] = findJobBlocks(fs.readFileSync(a, "utf-8"));
    expect(block).toMatchObject({ jobId: JOB, notebookAnchor: "unattributed" });
    const [record] = await listAttemptRecords(path.dirname(a));
    expect(record.attempt_id).toBe(block.attemptId);
    expect(record.origin).toBe("submission");
  });
});

describe("reconcile's side of the ledger", () => {
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const deps = (listed: string[] = []) => ({
    listJobs: async ({ offset }: { offset: number }) =>
      offset === 0
        ? listed.map((id) => ({
            id,
            state: "ok",
            create_time: "2026-10-20T10:59:00",
            history_id: HISTORY,
            tool_id: "cat1",
          }))
        : [],
    listInvocations: async () => [],
    getInvocation: async () => {
      throw new Error("none");
    },
    verify: async () => ({ outcome: "found" as const }),
    now: () => NOW,
  });
  const lostAt = (nb: string, at: number, callId = "lost-1") =>
    submissionLedger().dispatched({
      callId,
      attemptId: "att-lost",
      toolName: "run_tool",
      recordKey: nb,
      stepAnchor: "step-2",
      historyId: HISTORY,
      server: SERVER,
      dispatchedAt: new Date(at).toISOString(),
    });

  beforeEach(() => {
    setGalaxyTransport({ credentials: CREDENTIALS, fetch: async () => json({}) });
  });

  it("with no ledger entry there is no history to look in", async () => {
    setNotebookPath(analysis());
    const result = await runReconcile("command", deps());
    expect(result.skipped).toMatch(/no history/);
  });

  it("looks for a lost answer in the ledger's history, from its dispatch time, then closes it", async () => {
    const nb = analysis();
    setNotebookPath(nb);
    const sent = Date.parse("2026-10-20T11:00:00Z");
    await lostAt(nb, sent);
    const result = await runReconcile("command", deps([JOB]));
    expect(result.historyId).toBe(HISTORY);
    expect(Date.parse(result.since!)).toBeLessThanOrEqual(sent);
    expect(result.unattributed.map((u) => u.id)).toEqual([JOB]);
    expect(result.lostResponses).toEqual([
      { callId: "lost-1", toolName: "run_tool", dispatchedAt: new Date(sent).toISOString() },
    ]);
    expect(await submissionLedger().open(nb)).toEqual([]);
  });

  it("leaves an entry inside its call's deadline open", async () => {
    const nb = analysis();
    setNotebookPath(nb);
    await lostAt(nb, NOW - GALAXY_DEADLINE_MS / 2);
    const result = await runReconcile("command", deps());
    expect(result.lostResponses).toBeUndefined();
    expect(await submissionLedger().open(nb)).toHaveLength(1);
  });

  it("doesn't move the window for a call still waiting on its answer", async () => {
    const nb = analysis();
    setNotebookPath(nb);
    // The window as it stands, from a first pass that fixes the analysis start.
    // A clock just past the real one: the in-flight call below is dispatched now, and only an
    // entry dispatched before the window's start could move it.
    const soon = { ...deps(), now: () => Date.now() + 60_000 };
    const before = await runReconcile("command", soon);
    expect(before.skipped).toMatch(/no history/);
    await submissionLedger().dispatched({
      callId: "history-maker",
      attemptId: "a",
      toolName: "run_tool",
      recordKey: nb,
      stepAnchor: "s",
      historyId: HISTORY,
      server: SERVER,
      dispatchedAt: new Date().toISOString(),
    });
    await submissionLedger().responded("history-maker", {
      kind: "jobs",
      label: "x",
      historyId: HISTORY,
      jobs: [{ jobId: JOB }],
    });
    await submissionLedger().captured("history-maker");
    const settledSince = (await runReconcile("command", soon)).since;
    expect(settledSince).not.toBeNull();

    let release!: () => void;
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: (url) =>
        new URL(url).pathname === "/api/version"
          ? Promise.resolve(json({}))
          : new Promise((resolve) => (release = () => resolve(accepted()))),
    });
    const call = runOp("upload_file_from_url", UPLOAD);
    await vi.waitFor(() => expect(release).toBeDefined());
    const during = await runReconcile("command", soon);
    expect(during.since).toBe(settledSince);
    release();
    await call;
  });
});
