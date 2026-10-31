// @vitest-environment node
/**
 * Step-0 recovery experiments for the destructive gate's pause (plan decision 18). Each boot is a
 * worker_thread running Orbit's brain on pi-host over a SQLite pi-durable store, so a crash is a
 * terminate() and a reopen is a fresh worker on the same file, as a lease-holding host worker
 * would see it. The model asks for update_history deleted:true; the gate asks; the experiments
 * vary what happens to the harness and the pending ask before the conversation is reopened.
 */
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { bundleRecoveryWorker, REPO } from "./recovery-bundle";
import {
  type BootOptions,
  DELETE_CALL_ID,
  DELETE_PROMPT,
  type FromWorker,
  type Inspection,
  type RecoveryWorkerData,
  type ToWorker,
} from "./recovery-protocol";

const ORIGINAL_CWD = process.cwd();
const tmp = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "orbit-recovery-")));
let bundle: string;

beforeAll(async () => {
  bundle = await bundleRecoveryWorker(join(tmp, "recovery-worker.mjs"));
  // Orbit writes some side files beside process.cwd(), which a worker cannot change; the forks
  // pool lets the test move the whole process instead.
  process.chdir(tmp);
}, 120_000);

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A failed assertion skips a test's own kill(), and a stray worker keeps Orbit's Galaxy poller and
// any confirm parked under close() alive past afterAll's cleanup.
const live = new Set<Boot>();
afterEach(async () => {
  await Promise.all([...live].map((b) => b.kill()));
});

/** One worker: everything it posted, in order, and the means to wait for more. */
class Boot {
  readonly log: FromWorker[] = [];
  readonly worker: Worker;
  exited = false;
  error: unknown;
  #rpc = 0;
  #waiters = new Set<() => void>();

  constructor(data: RecoveryWorkerData, { freshSession = false }: BootOptions = {}) {
    this.worker = new Worker(bundle, {
      workerData: data,
      // Nothing from the test process's environment reaches the brain (milestone 0's `env: {}`),
      // apart from a home that is not the developer's.
      env: {
        HOME: data.dir,
        USERPROFILE: data.dir,
        PI_CODING_AGENT_DIR: join(data.dir, ".pi"),
        ...(freshSession ? { ORBIT_FRESH_SESSION: "1" } : {}),
      },
    });
    live.add(this);
    this.worker.on("message", (m: FromWorker) => {
      this.log.push(m);
      for (const w of this.#waiters) w();
    });
    this.worker.on("error", (e) => {
      this.error = e;
      for (const w of this.#waiters) w();
    });
    this.worker.on("exit", () => {
      this.exited = true;
      for (const w of this.#waiters) w();
    });
  }

  send(message: ToWorker) {
    this.worker.postMessage(message);
  }

  /** The first message (from `from` on) matching `match`, waiting up to `ms` for it. */
  async next<T extends FromWorker["type"]>(
    type: T,
    match: (m: Extract<FromWorker, { type: T }>) => boolean = () => true,
    { from = 0, ms = 30_000 } = {},
  ): Promise<Extract<FromWorker, { type: T }>> {
    const find = () =>
      this.log
        .slice(from)
        .find(
          (m): m is Extract<FromWorker, { type: T }> =>
            m.type === type && match(m as Extract<FromWorker, { type: T }>),
        );
    const deadline = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found) return found;
      if (this.error) throw this.error;
      if (this.exited) throw new Error(`worker exited before ${type}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${type}: ${this.summary()}`);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.#waiters.add(done);
      });
    }
  }

  async call<T>(cmd: "idle" | "inspect"): Promise<T> {
    const rpc = ++this.#rpc;
    this.send({ cmd, rpc });
    return (await this.next("rpc", (m) => m.rpc === rpc)).value as T;
  }

  of<T extends FromWorker["type"]>(type: T): Array<Extract<FromWorker, { type: T }>> {
    return this.log.filter((m): m is Extract<FromWorker, { type: T }> => m.type === type);
  }

  /** Galaxy requests that would change h1: the destructive call reaching Galaxy. */
  writes() {
    return this.of("galaxy").filter((g) => g.path === "/api/histories/h1" && g.method !== "GET");
  }

  summary() {
    return JSON.stringify(
      this.log.filter((m) => m.type !== "galaxy" && m.type !== "model").slice(-25),
    );
  }

  async kill() {
    live.delete(this);
    await this.worker.terminate();
  }
}

let n = 0;
/** A fresh store and side-file directory per experiment. */
function experiment() {
  const dir = join(tmp, `x${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return { repo: REPO, dir, store: join(dir, "durable.sqlite") };
}

/** First boot: greeting settled, then the delete prompt, up to the gate's pending ask. */
async function bootToPendingAsk(base: RecoveryWorkerData) {
  const boot = new Boot(base);
  const { conversationId } = await boot.next("ready");
  await boot.call("idle");
  boot.send({ cmd: "submit", text: DELETE_PROMPT });
  const ask = await boot.next("ask");
  return { boot, conversationId, ask };
}

/** Reopen the conversation in a new worker on the same store. */
async function reopen(base: RecoveryWorkerData, conversationId: string, options?: BootOptions) {
  const boot = new Boot({ ...base, conversationId }, options);
  await boot.next("ready");
  return boot;
}

/** Approve the ask and let the call run and the turn finish. */
async function approve(boot: Boot, id: number) {
  boot.send({ cmd: "answer", id, outcome: "resolve", value: true });
  await boot.next(
    "event",
    (e) => e.event === "tool_execution_end" && e.toolCallId === DELETE_CALL_ID,
  );
  await boot.call("idle");
  return boot.call<Inspection>("inspect");
}

/** What the context view shows for a tool call that has no committed result. */
const UNANSWERED = "Tool result unavailable: history ends before this call completed.";

const deleteResults = (i: Inspection) =>
  i.toolResults.filter((r) => r.toolCallId === DELETE_CALL_ID);

/** The one write reaching Galaxy is the delete itself, not some other PUT to h1. */
function expectSingleDelete(boot: Boot) {
  const writes = boot.writes();
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0].body ?? "{}")).toMatchObject({ deleted: true });
}

/** Orbit's greeting runs on every session_start that is not --continue or FRESH_SESSION=1. */
const BUSY_GREETING = "busy sendUserMessage";

/** What each experiment saw, printed once at the end as the run's evidence. */
const evidence: Record<string, unknown> = {};

afterAll(() => {
  // vitest drops a passing file's console output, so the evidence goes to the spike's scratch.
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch", "recovery");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
});

describe("destructive gate pause and recovery", () => {
  it("A: a worker killed while the confirm is pending asks again on reopen, and runs once", async () => {
    const base = experiment();
    const { boot: first, conversationId, ask } = await bootToPendingAsk(base);
    expect(ask.request).toMatchObject({
      kind: "confirm",
      title: "Confirm destructive Galaxy operation",
    });
    expect(first.writes()).toEqual([]);
    // The crash: no close, no answer; the thread is gone with the ask still pending.
    await first.kill();

    const second = await reopen(base, conversationId);
    const again = await second.next("ask");
    const tasksAtAsk = await second.call<Inspection>("inspect");
    expect(again.request).toEqual(ask.request);
    expect(tasksAtAsk.tasks).toContainEqual(
      expect.objectContaining({ kind: "pi.tool", status: "running", phase: "call" }),
    );
    expect(deleteResults(tasksAtAsk)).toEqual([
      expect.objectContaining({ isError: true, text: UNANSWERED }),
    ]);
    // The same call: the reopened ToolTask reran beforeTool for del1, not a new model turn.
    expect(
      second
        .of("event")
        .filter((e) => e.event === "tool_call")
        .map((e) => e.toolCallId),
    ).toEqual([DELETE_CALL_ID]);
    expect(second.of("model")).toEqual([]);
    expect(second.writes()).toEqual([]);
    // The reopen's startup greeting was sent and refused because the conversation is durably
    // mid-turn; on an idle conversation it runs (C, C2).
    expect(second.of("note").map((x) => x.note)).toContain(BUSY_GREETING);

    const after = await approve(second, again.id);
    expectSingleDelete(second);
    expect(deleteResults(after)).toHaveLength(1);
    expect(deleteResults(after)[0].isError).toBe(false);
    evidence.A = {
      firstAsk: ask,
      secondAsk: again,
      tasksWhileAskingAgain: tasksAtAsk.tasks,
      deleteResultsWhileAskingAgain: deleteResults(tasksAtAsk),
      writes: second.writes(),
      deleteResults: deleteResults(after),
      reopenNotes: second.of("note").map((x) => x.note),
      reports: [...first.of("report"), ...second.of("report")].map((r) => r.message),
    };
    await second.kill();
  }, 120_000);

  it("B: close first, then reject the ask -- the call stays undecided and asks again on reopen", async () => {
    const base = experiment();
    const { boot: first, conversationId, ask } = await bootToPendingAsk(base);
    first.send({ cmd: "close" });
    await first.next("close-called");
    // close() joins invocations, and this one is parked in the gate's confirm. The gate hands the
    // confirm the invocation signal (D), so close withdraws the ask; close still can't finish until
    // the host settles it, which it does by rejecting -- the close-then-reject contract.
    await first.next("ask-withdrawn", (w) => w.id === ask.id);
    await sleep(500);
    const closedBeforeReject = first.of("closed").length > 0;
    expect(closedBeforeReject).toBe(false);
    const abortedBeforeReject = first.of("call-signal-aborted").length > 0;
    expect(abortedBeforeReject).toBe(true);
    first.send({ cmd: "answer", id: ask.id, outcome: "reject", message: "paused" });
    const closed = await first.next("closed");
    expect(closed.error).toBeUndefined();
    expect(first.writes()).toEqual([]);
    await first.kill();

    const second = await reopen(base, conversationId);
    const again = await second.next("ask");
    expect(again.request).toEqual(ask.request);
    expect(second.of("note").map((x) => x.note)).toContain(BUSY_GREETING);
    const after = await approve(second, again.id);
    expectSingleDelete(second);
    expect(deleteResults(after)).toHaveLength(1);
    expect(deleteResults(after)[0].isError).toBe(false);
    evidence.B = {
      closedBeforeReject,
      callSignalAbortedBeforeReject: abortedBeforeReject,
      // Always empty: the scheduler drops reports while closing, so this is not evidence of a
      // clean close. The reopened state is.
      firstReports: first.of("report").map((r) => r.message),
      firstNotes: first.of("note").map((x) => x.note),
      secondAsk: again,
      deleteResults: deleteResults(after),
    };
    await second.kill();
  }, 120_000);

  it("B2: close first, then answer false -- also undecided, since the deny's commit is refused", async () => {
    const base = experiment();
    const { boot: first, conversationId, ask } = await bootToPendingAsk(base);
    first.send({ cmd: "close" });
    await first.next("close-called");
    first.send({ cmd: "answer", id: ask.id, outcome: "resolve", value: false });
    const closed = await first.next("closed");
    expect(closed.error).toBeUndefined();
    expect(first.writes()).toEqual([]);
    await first.kill();

    const second = await reopen(base, conversationId);
    const again = await second.next("ask", () => true, { ms: 15_000 }).catch(() => undefined);
    const state = await second.call<Inspection>("inspect");
    evidence.B2 = {
      closed,
      // Always empty while closing (see B). That the deny's commit was refused -- the closedError
      // pi-durable's #gated throws and #step swallows -- is inferred from the reopened state, not
      // observed directly.
      firstReports: first.of("report").map((r) => r.message),
      firstWrites: first.writes(),
      askedAgain: again !== undefined,
      deleteResultsBeforeApproval: deleteResults(state),
      tasks: state.tasks,
    };
    expect(again).toBeDefined();
    expect(again!.request).toEqual(ask.request);
    // The context view stands a placeholder in for a call with no result yet; the deny itself
    // never landed.
    expect(deleteResults(state)).toEqual([
      expect.objectContaining({ isError: true, text: UNANSWERED }),
    ]);
    const after = await approve(second, again!.id);
    expectSingleDelete(second);
    expect(deleteResults(after)).toHaveLength(1);
    expect(deleteResults(after)[0].isError).toBe(false);
    await second.kill();
  }, 120_000);

  it.each([
    ["C: answer false before close", { outcome: "resolve", value: false } as const],
    ["C2: reject before close", { outcome: "reject", message: "paused" } as const],
  ])(
    "%s -- the call is recorded as blocked and never asks again",
    async (label, answer) => {
      const base = experiment();
      const { boot: first, conversationId, ask } = await bootToPendingAsk(base);
      first.send({ cmd: "answer", id: ask.id, ...answer } as ToWorker);
      await first.next(
        "event",
        (e) => e.event === "tool_execution_end" && e.toolCallId === DELETE_CALL_ID,
      );
      await first.call("idle");
      const before = await first.call<Inspection>("inspect");
      first.send({ cmd: "close" });
      await first.next("closed");
      await first.kill();

      const second = await reopen(base, conversationId);
      await second.call("idle");
      // Give a rerun every chance to ask before concluding it will not.
      await sleep(1_000);
      const state = await second.call<Inspection>("inspect");
      evidence[label.split(":")[0]] = {
        deleteResultsBeforeClose: deleteResults(before),
        deleteResultsAfterReopen: deleteResults(state),
        askedOnReopen: second.of("ask").length,
        // tasksAfterReopen is after the replayed greeting's turn below has finished.
        tasksAfterReopen: state.tasks,
        reopenModelRequests: second.of("model"),
        reopenNotes: second.of("note").map((x) => x.note),
      };
      expect(second.of("ask")).toEqual([]);
      // host.start("resume") does not reach Orbit as a resume, so the idle conversation gets the
      // startup greeting again as a new user turn -- one extra model call per reopen.
      expect(second.of("model")).toEqual([
        expect.objectContaining({ lastRole: "user", lastText: first.of("model")[0].lastText }),
      ]);
      expect(second.of("event").filter((e) => e.event === "tool_call")).toEqual([]);
      expect(first.writes()).toEqual([]);
      expect(second.writes()).toEqual([]);
      const [result] = deleteResults(state);
      expect(deleteResults(state)).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        answer.outcome === "resolve" ? "Destructive Galaxy operation cancelled by user." : "paused",
      );
      await second.kill();
    },
    120_000,
  );

  it("D: the gate's confirm carries the invocation signal, so closing the harness withdraws it", async () => {
    const base = experiment();
    const { boot: first, ask } = await bootToPendingAsk(base);
    // pi-host's ask is handed the confirm's opts.signal, which the gate fills from ctx.signal.
    expect(ask.hasSignal).toBe(true);
    const signal = await first.next("call-signal", (s) => s.toolCallId === DELETE_CALL_ID);
    expect(signal).toMatchObject({ present: true, aborted: false });
    first.send({ cmd: "close" });
    await first.next("close-called");
    const aborted = await first
      .next("call-signal-aborted", (s) => s.toolCallId === DELETE_CALL_ID, { ms: 2_000 })
      .catch(() => undefined);
    await sleep(500);
    evidence.D = {
      askHadSignal: ask.hasSignal,
      callSignalOnToolCall: signal,
      callSignalAbortedOnClose: aborted !== undefined,
      askWithdrawn: first.of("ask-withdrawn").length > 0,
      closedWhileAskPending: first.of("closed").length > 0,
    };
    expect(aborted).toBeDefined();
    expect(first.of("ask-withdrawn").map((w) => w.id)).toEqual([ask.id]);
    // Withdrawal tells the host; settling the ask is still the host's job.
    expect(first.of("closed")).toEqual([]);
    first.send({ cmd: "answer", id: ask.id, outcome: "reject", message: "paused" });
    await first.next("closed");
    await first.kill();
  }, 120_000);

  it("E: with ORBIT_FRESH_SESSION=1 on reopen, an idle conversation makes no model call", async () => {
    const base = experiment();
    const first = new Boot(base);
    const { conversationId } = await first.next("ready");
    await first.call("idle");
    const greeting = first.of("model");
    first.send({ cmd: "close" });
    await first.next("closed");
    await first.kill();

    const plain = await reopen(base, conversationId);
    await plain.call("idle");
    await sleep(1_000);
    const plainModel = plain.of("model");
    plain.send({ cmd: "close" });
    await plain.next("closed");
    await plain.kill();

    const fresh = await reopen(base, conversationId, { freshSession: true });
    await fresh.call("idle");
    await sleep(1_000);
    const state = await fresh.call<Inspection>("inspect");
    evidence.E = {
      firstBootModelRequests: greeting,
      plainReopenModelRequests: plainModel,
      freshReopenModelRequests: fresh.of("model"),
      freshReopenTasks: state.tasks,
    };
    expect(greeting).toHaveLength(1);
    expect(plainModel).toEqual([expect.objectContaining({ lastText: greeting[0].lastText })]);
    expect(fresh.of("model")).toEqual([]);
    await fresh.kill();
  }, 120_000);
});
