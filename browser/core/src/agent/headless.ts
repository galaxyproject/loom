/**
 * One conversation driven without a page, for the evaluation harness and tests: the Orbit worker
 * (orbit/worker.ts) run in-process under Node, spoken to through the page protocol, with what it
 * hands back read from pi-durable's own record of the conversation, the entries each step appended.
 *
 * Orbit's brain writes beside its record and the process's working directory, so a session moves
 * the process into a directory of its own until it closes.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryStorage,
  type EntryRecord,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";

import { createMemoryLedger } from "../../../../extensions/orbit/submission-ledger";
import { Binding } from "./documents";
import type { RecordSummary } from "./records";
import { orbitSession, startOrbitWorker, stopOrbitWorker, submitText } from "./orbit/worker";
import { readShippedSkill } from "./orbit/skills-node";
import { ORBIT_WATCH } from "./orbit/watch";
import { context, type Placement, type RuntimeConfig } from "./runtime";
import type { SessionDocument } from "./saved";
import type { Python } from "./tool";
import type { AgentFlavor } from "./tools";
import type { Settled } from "./orbit/watch";
import type { PageMessage, WorkerMessage } from "./worker";

export interface HeadlessConfig extends RuntimeConfig {
  history_id?: string;
  dataset_id?: string;
  /** The conversation's own instructions, after the agent's prompt. */
  instructions?: string;
}

export interface HeadlessOptions {
  python: Python;
  env?: Record<string, string | undefined>;
  storage?: Storage;
  flavor?: AgentFlavor;
  /** How a confirmation the brain asks for is answered: declined unless this says otherwise. */
  confirm?: (title: string, message: string) => boolean;
  /** A saved session to open on, as a page opened on a saved visualization does. */
  saved?: { id: string; document: SessionDocument };
}

const timeout = (ms: number) =>
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

/** Until `done` holds, or `ms` pass. */
async function until(done: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return done();
}

export class Headless {
  /** The newest entry already handed back. */
  private last = 0;
  /** What a restart was launched on, and the records it offered to continue. */
  private launch: Placement = {};
  private offered: RecordSummary[] = [];
  private posted: WorkerMessage[] = [];
  /** The first posted message `settle` hasn't read the Settled of. */
  private settledFrom = 0;
  private send: (message: PageMessage) => void = () => {};

  private constructor(
    private readonly config: HeadlessConfig,
    private readonly options: HeadlessOptions,
    /** The directory the session's records and Orbit's side files are under; the prompt names it. */
    readonly root: string,
    private readonly home: string,
  ) {}

  /** The worker's runtime: the model, the storage, the conversations. */
  get runtime() {
    return orbitSession().runtime!;
  }

  get conversation() {
    return orbitSession().conversation!;
  }

  static async open(config: HeadlessConfig, options: HeadlessOptions) {
    // Orbit's brain and the worker under it are the process's: one session at a time.
    if (orbitSession().open) throw new Error("A Headless session is already open in this process.");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "orbit-headless-")));
    const session = new Headless(config, options, root, process.cwd());
    process.chdir(root);
    try {
      const offered = await session.boot(options.storage ?? new MemoryStorage(), {
        historyId: config.history_id,
        datasetId: config.dataset_id,
        instructions: config.instructions,
      });
      // A new session, as the old one always started: an offered record is not continued.
      if (offered.length) await session.recover();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  /** Start the worker on `placement`: what it offers to continue, or nothing once it is ready. */
  private async boot(storage: Storage, placement: Placement): Promise<RecordSummary[]> {
    this.posted = [];
    this.settledFrom = 0;
    this.launch = placement;
    this.send = startOrbitWorker(this.options.flavor ?? {}, {
      post: (message) => this.receive(message),
      base: () => "http://localhost/",
      python: () => this.options.python,
      keep: async () => ({ storage, ledger: createMemoryLedger() }),
      root: this.root,
      readSkill: readShippedSkill,
      vars: this.options.env,
    });
    this.send({
      type: "open",
      request: {
        pyodideURL: "",
        config: this.config,
        placement,
        ...(this.options.saved ? { saved: this.options.saved } : {}),
      },
    });
    const answered = await until(
      () => this.posted.some((m) => /^(ready|recoverable|failed)$/.test(m.type)),
      60_000,
    );
    if (!answered) throw new Error("The worker neither opened the session nor failed within 60s.");
    const failed = this.posted.find((m) => m.type === "failed");
    if (failed) throw new Error(failed.message);
    const recoverable = this.posted.find((m) => m.type === "recoverable");
    this.offered = recoverable?.records ?? [];
    if (!this.offered.length) await this.fresh();
    return this.offered;
  }

  private receive(message: WorkerMessage) {
    this.posted.push(message);
    if (message.type === "confirm") {
      const approved = this.options.confirm?.(message.title, message.message) ?? false;
      queueMicrotask(() => this.send({ type: "confirmed", id: message.id, approved }));
    }
  }

  /** The entries appended since the last hand-back, in order. */
  private async fresh(): Promise<EntryRecord[]> {
    const entries = (await this.conversation.context(context)).entries.filter(
      (e) => e.id > this.last,
    );
    this.last = Math.max(this.last, ...entries.map((e) => e.id));
    return entries;
  }

  /** The user's message, answered: how its submission settled, and what the run appended. */
  async turn(text: string) {
    const submission = await submitText(text);
    if (!submission) return { status: "handled", entries: await this.fresh() };
    const settled = await submission.wait(context);
    return {
      status: settled.status,
      ...(settled.status === "unanswered"
        ? { reason: (settled as { reason?: string }).reason }
        : {}),
      entries: await this.fresh(),
    };
  }

  /** Galaxy work the conversation still watches. */
  private async watching(): Promise<TaskId[]> {
    const { tasks } = await this.runtime.harness.inspect(context);
    return tasks
      .filter(
        (t) => t.record.kind === ORBIT_WATCH && t.record.conversationId === this.conversation.id,
      )
      .map((t) => t.record.id);
  }

  /**
   * Wait for submitted work to settle and for the runs its follow-ups start, as an open tab would:
   * what settled, and the entries those runs appended.
   */
  async settle(timeoutSeconds: number) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let pending = await this.watching();
    while (Date.now() < deadline) {
      for (const id of pending) {
        const done = await Promise.race([
          this.runtime.harness.waitForTask(id, context),
          timeout(deadline - Date.now()),
        ]);
        if (done === "timeout") break;
      }
      const idle = await Promise.race([
        this.conversation.waitForIdle(context),
        timeout(deadline - Date.now()),
      ]);
      pending = await this.watching();
      if (idle === "timeout" || !pending.length) break;
    }
    // From where the last settle stopped: work can settle during a turn, before this was called.
    const settled = this.posted
      .slice(this.settledFrom)
      .flatMap((m) => (m.type === "settled" ? [m.settled as Settled] : []));
    this.settledFrom = this.posted.length;
    return { settled, pending: pending.length, entries: await this.fresh() };
  }

  /**
   * A tab closed and opened again with nothing stored, as a browser does it: launched on the same
   * history and dataset, it offers the brand's records attached to that history and starts nothing
   * until `recover` says which session this is, as the user does in a tab. With no records, a new
   * session starts at once.
   */
  async restart(): Promise<RecordSummary[]> {
    const bound = await this.runtime.harness.snapshot(Binding, this.conversation.id, context);
    const placement = { historyId: bound?.historyId, datasetId: bound?.datasetId };
    await stopOrbitWorker();
    this.last = 0;
    return this.boot(new MemoryStorage(), placement);
  }

  /** Continue the offered session whose record is `pageId`, or start a new one. */
  async recover(pageId?: string) {
    const record = this.offered.find((r) => r.pageId === pageId);
    if (pageId && !record) throw new Error(`No offered record ${pageId}.`);
    if (!this.offered.length)
      throw new Error("Nothing is offered to recover: the session is open.");
    const from = this.posted.length;
    this.send({ type: "recover", ...(record ? { pageId } : {}) });
    const answered = await until(
      () => this.posted.slice(from).some((m) => /^(ready|failed)$/.test(m.type)),
      60_000,
    );
    if (!answered) throw new Error("The worker neither started the session nor failed within 60s.");
    const failed = this.posted.slice(from).find((m) => m.type === "failed");
    if (failed) throw new Error(failed.message);
    this.offered = [];
    this.last = 0;
    await this.fresh();
  }

  /** The placement the session was launched on. */
  get placement(): Placement {
    return this.launch;
  }

  export(title = "") {
    return this.runtime.export(this.conversation, title);
  }

  async close() {
    try {
      await stopOrbitWorker();
    } finally {
      process.chdir(this.home);
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
