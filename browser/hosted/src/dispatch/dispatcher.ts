/**
 * Dispatch and leases (brief H7). A message lands in the conversation's inbox and a `turn` job is sent
 * for it; pg-boss's `stately` policy keeps at most one turn queued behind one running per
 * conversation, and the queued one drains the whole inbox, so messages that arrive while it waits
 * are coalesced into it.
 *
 * The handler claims the user's live loop and the conversation's lease in one transaction without
 * waiting on either (decision 6): if another of the user's conversations is live, or another host
 * holds the lease, it sends the turn again a little later and returns. Otherwise it hands the turn to
 * the conversation's sticky worker, booting one if there is none, and waits for the run to settle.
 * The lease is held for the worker's life and renewed on a timer; the generation moves only when a
 * new worker takes over (decision 9).
 *
 * Workers don't stay forever (idle.ts): a quiet conversation nobody has open gives its worker back
 * at a quiet point, and a confirm left unanswered pauses its conversation until the user returns.
 */
import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

import type { AskAnswer, AskRequest } from "../../../core/src/agent/pi-host";
import { acquireLeaseInTransaction, releaseLease, renewLease } from "../lease/leases";
import { LEASE_LOST_EXIT_CODE } from "../lease/lease-fence";
import { withTransaction } from "../storage/postgres-storage";
import { answerTokenRequest } from "../tokens/serve";
import type { TokenCache } from "../tokens/token-cache";
import type { FromWorker, WorkerData } from "../worker/protocol";
import { spawnWorker } from "../worker/spawn";
import { getConversation, interruptedConversations, type ConversationRow } from "./conversations";
import { idleAction, idleCheckMs, type IdleSettings } from "./idle";

export const TURN_QUEUE = "turn";

/** What the dispatcher tells the conversation's browser, besides what its worker says. */
export type DispatchEvent =
  /** The turn waits: another of the user's conversations is running or asking them something. */
  | { readonly type: "waiting" }
  | { readonly type: "worker-exit"; readonly code: number }
  /** The turn couldn't start after several tries. */
  | { readonly type: "failed"; readonly message: string }
  /** A confirm went unanswered too long; the conversation asks again when the user comes back. */
  | { readonly type: "paused" };

export interface DispatcherOptions {
  readonly pool: Pool;
  readonly boss: PgBoss;
  /** The bundled worker (worker/bundle.ts). */
  readonly bundle: string;
  /** This host process; leases and live loops name it, so a restarted host is a new holder. */
  readonly hostId: string;
  /** Handed to workers. */
  readonly databaseUrl: string;
  readonly galaxyUrl: string;
  readonly lease: { readonly ttlMs: number; readonly renewMs: number; readonly maxTurnMs: number };
  readonly limits: WorkerData["limits"];
  /** Handed to workers for V8's compile cache. */
  readonly compileCache?: string;
  readonly tokens: TokenCache;
  /** The model a user's worker talks to, with their key (H9). */
  readonly modelFor: (sub: string) => WorkerData["model"];
  /** The conversation's Galaxy page, created on first use. */
  readonly pageFor: (conversation: ConversationRow) => Promise<string>;
  readonly onEvent: (conversationId: string, event: FromWorker | DispatchEvent) => void;
  /** Turns run at once in this host. Each holds a worker, not a database connection. */
  readonly concurrency?: number;
  /**
   * The kill switch: while it returns a reason, no turn starts (queued ones, the sweeper's and
   * resumed runs included); conversations are marked so they pick up once it's lifted.
   */
  readonly turnsDisabled?: () => string | undefined;
  /** How long a turn that couldn't start waits before trying again, by attempt (0-based). */
  readonly retryDelayMs?: (attempt: number) => number;
  /**
   * How long a turn job's handler can go silent before pg-boss's monitor fails the job: a host killed
   * outright leaves its job active, and the conversation's next job can't start until it isn't.
   */
  readonly jobHeartbeatSeconds?: number;
  /** Idle release and the unanswered-confirm pause; without it, workers stay until shutdown. */
  readonly idle?: IdleSettings & { readonly checkMs?: number };
  /** Whether a page has the conversation open, which keeps its worker from being released. */
  readonly watched?: (conversationId: string) => boolean;
  readonly spawn?: (bundle: string, data: WorkerData) => Worker;
  readonly log?: (message: string) => void;
}

interface Waiter {
  readonly type: FromWorker["type"];
  readonly resolve: (message: FromWorker) => void;
  readonly reject: (error: Error) => void;
}

/** A turn from its first input (or a resumed run) until the run settles. */
interface Turn {
  cap?: NodeJS.Timeout;
  /**
   * The run is this turn's: its input was taken, or it's an interrupted run resumed. Until then a
   * settled is some other run's (a greeting the input waited behind) and doesn't end the turn.
   */
  running: boolean;
  /** Settles when the turn ends, however it ends. */
  readonly done: Promise<void>;
  readonly end: () => void;
}

interface Live {
  readonly conversationId: string;
  readonly sub: string;
  readonly storeId: string;
  readonly holder: string;
  readonly leaseGen: number;
  readonly worker: Worker;
  /** Asks waiting on the user, so a page that (re)connects can show them, and when each was asked. */
  readonly asks: Map<number, { readonly request: AskRequest; readonly at: number }>;
  readonly waiters: Set<Waiter>;
  renew?: NodeJS.Timeout;
  turn?: Turn;
  exited: boolean;
  /** Set when the host ends the worker on purpose (the turn cap, a lost lease), so its exit isn't a crash. */
  retired?: boolean;
  /** The last turn's end bookkeeping (the live loop, the conversation's marks). */
  ending?: Promise<unknown>;
  /** Since when nothing has run, asked or watched; idle release counts from here. */
  quietSince: number;
  /** The host is closing the worker (idle release, or a pause); `done` once it's gone or stays. */
  releasing?: {
    readonly why: "idle" | "pause";
    readonly done: Promise<void>;
    readonly end: () => void;
    timer?: NodeJS.Timeout;
  };
}

type TurnJob = { conversationId: string; attempt?: number };

class Busy extends Error {}

/** Five tries at a turn that keeps failing to start; after that the user's next message tries again. */
const MAX_ATTEMPTS = 5;

export class Dispatcher {
  readonly #o: DispatcherOptions;
  readonly #live = new Map<string, Live>();
  /** Conversations with a handler running on this host. */
  readonly #handling = new Set<string>();
  /** Bookkeeping still writing (a turn's end, a worker's exit), which shutdown waits for. */
  readonly #settling = new Set<Promise<unknown>>();
  /** Workers that crashed mid-turn since the conversation last settled, so a crash loop gives up. */
  readonly #crashes = new Map<string, number>();
  #working = false;
  #stopping = false;
  #idleTimer?: NodeJS.Timeout;

  constructor(options: DispatcherOptions) {
    this.#o = options;
  }

  /** Create the queue if needed, start taking turns, and pick up conversations a restart cut off. */
  async start(): Promise<void> {
    const { boss } = this.#o;
    const heartbeatSeconds = this.#o.jobHeartbeatSeconds ?? 30;
    const queue = await boss.getQueue(TURN_QUEUE);
    if (!queue) {
      await boss.createQueue(TURN_QUEUE, {
        policy: "stately",
        // A handler waits at most for a boot and the turn cap: it returns once the run asks the
        // user anything, and the cap stops a run that goes on.
        expireInSeconds: Math.ceil(this.#o.lease.maxTurnMs / 1000) + 600,
        retryLimit: 0,
        heartbeatSeconds,
      });
    } else if (queue.heartbeatSeconds !== heartbeatSeconds) {
      // Queues made before the heartbeat existed.
      await boss.updateQueue(TURN_QUEUE, { heartbeatSeconds });
    }
    await boss.work(
      TURN_QUEUE,
      { localConcurrency: this.#o.concurrency ?? 32, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        await this.#handle(job!.data as TurnJob);
      },
    );
    this.#working = true;
    const idle = this.#o.idle;
    if (idle) {
      this.#idleTimer = setInterval(() => this.#idleCheck(idle), idle.checkMs ?? idleCheckMs(idle));
      this.#idleTimer.unref();
    }
    // The sweeper: a turn cut off by a crash or a restart resumes without waiting for a new message.
    if (this.#o.turnsDisabled?.()) return;
    for (const id of await interruptedConversations(this.#o.pool))
      await this.#send({ conversationId: id });
  }

  /**
   * Queue a message for the conversation's next turn. Delivered at least once: a worker that dies
   * between taking the message into its durable inbox and acknowledging it gets it again.
   */
  async submit(conversationId: string, text: string): Promise<void> {
    await this.#o.pool.query(
      "WITH c AS (UPDATE orbit_conversations SET last_active_at = now() WHERE id = $1) INSERT INTO orbit_inbox (conversation_id, text) VALUES ($1, $2)",
      [conversationId, text],
    );
    // A turn running here (or a handler about to drain) takes it when it gets to it; a job queued
    // behind an active one would stall pg-boss's fetch for every conversation (stately's unique
    // index against a queue cache refreshed once a minute).
    if (this.#handling.has(conversationId) || this.#live.get(conversationId)?.turn) return;
    await this.#send({ conversationId });
  }

  /** The user's Stop: the run aborts, and a pending confirm is withdrawn with its call not run. */
  stop(conversationId: string): void {
    this.#live.get(conversationId)?.worker.postMessage({ cmd: "stop" });
  }

  /**
   * The user's answer to an ask; false, and ignored, for one already answered or withdrawn. An answer
   * that races a pause is dropped too: the call asks again on resume.
   */
  answer(conversationId: string, id: number, value: AskAnswer): boolean {
    const live = this.#live.get(conversationId);
    if (!live || live.releasing || !live.asks.delete(id)) return false;
    live.worker.postMessage({ cmd: "answer", id, value });
    return true;
  }

  /** Whether the conversation has a worker on this host now, other than one being closed. */
  isLive(conversationId: string): boolean {
    const live = this.#live.get(conversationId);
    return live !== undefined && !live.releasing;
  }

  /**
   * The user came back to a conversation that paused on an unanswered confirm: start a worker, which
   * reruns the call and asks again.
   */
  async resume(conversationId: string): Promise<void> {
    if (this.#stopping || this.#handling.has(conversationId)) return;
    // Mid-pause, the turn waits for the closing worker to go first, as a message would.
    if (this.#live.has(conversationId) && !this.pausing(conversationId)) return;
    await this.#send({ conversationId });
  }

  /** Whether the conversation's worker is being closed for an unanswered confirm, not yet marked paused. */
  pausing(conversationId: string): boolean {
    return this.#live.get(conversationId)?.releasing?.why === "pause";
  }

  /** The last page on the conversation closed: its quiet period counts from now. */
  unwatched(conversationId: string): void {
    const live = this.#live.get(conversationId);
    if (live) live.quietSince = Date.now();
  }

  /** Ask the conversation's worker for a fresh snapshot; false when no worker is running it. */
  snapshot(conversationId: string): boolean {
    const live = this.#live.get(conversationId);
    if (!live || live.releasing) return false;
    live.worker.postMessage({ cmd: "snapshot" });
    return true;
  }

  /** What the conversation is waiting on the user for. */
  pendingAsks(conversationId: string): Array<{ id: number; request: AskRequest }> {
    const live = this.#live.get(conversationId);
    // A closing worker's asks are about to be withdrawn, and an answer to one is dropped.
    if (!live || live.releasing) return [];
    return [...live.asks].map(([id, { request }]) => ({ id, request }));
  }

  /**
   * Restart: stop taking turns and close every worker. Closing withdraws a pending confirm by
   * rejecting it in the worker, so it's asked again when the conversation resumes; a turn cut off
   * here marks its conversation for the next host's sweeper.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#idleTimer);
    // Workers close first, so each handler finishes and pg-boss records its job; a job left active
    // would hold the conversation's one active slot until it expired. A handler that boots a worker
    // meanwhile is caught by the second pass.
    for (let pass = 0; pass < 2; pass++) {
      await this.#closeAll(timeoutMs);
      if (pass === 0 && this.#working) await this.#o.boss.offWork(TURN_QUEUE, { wait: true });
    }
    this.#working = false;
    while (this.#settling.size) await Promise.all([...this.#settling]);
  }

  async #closeAll(timeoutMs: number): Promise<void> {
    await Promise.all(
      [...this.#live.values()].map(async (live) => {
        const closed = this.#next(live, "closed").catch(() => undefined);
        live.worker.postMessage({ cmd: "close" });
        const timer = setTimeout(() => void live.worker.terminate(), timeoutMs);
        await Promise.race([closed, new Promise((resolve) => live.worker.once("exit", resolve))]);
        clearTimeout(timer);
        await live.worker.terminate();
      }),
    );
  }

  #send(job: TurnJob, startAfterMs?: number): Promise<string | null> {
    // null when a turn is already queued for the conversation: it will drain this message too.
    return this.#o.boss.send(TURN_QUEUE, job, {
      singletonKey: job.conversationId,
      ...(startAfterMs ? { startAfter: Math.max(1, Math.ceil(startAfterMs / 1000)) } : {}),
    });
  }

  /** Try the turn again later, backing off; past the last attempt, tell the user and stop trying. */
  async #retry(job: TurnJob, why: string): Promise<void> {
    const attempt = (job.attempt ?? 0) + 1;
    if (attempt >= MAX_ATTEMPTS && why !== "busy") {
      this.#o.onEvent(job.conversationId, {
        type: "failed",
        message: "Orbit couldn't start this conversation's turn. Send a message to try again.",
      });
      return;
    }
    const delay =
      this.#o.retryDelayMs?.(attempt) ??
      Math.min(30_000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);
    await this.#send({ conversationId: job.conversationId, attempt }, delay);
  }

  async #handle(job: TurnJob): Promise<void> {
    const conversationId = job.conversationId;
    this.#handling.add(conversationId);
    try {
      await this.#runTurn(job);
    } finally {
      this.#handling.delete(conversationId);
      // A message that came while this handler ran, and found no turn to take it, still needs one.
      if (
        !this.#stopping &&
        !this.#live.get(conversationId)?.turn &&
        (await this.#hasInbox(conversationId))
      ) {
        await this.#send({ conversationId });
      }
    }
  }

  async #runTurn(job: TurnJob): Promise<void> {
    const { conversationId } = job;
    const { pool } = this.#o;
    const paused = this.#o.turnsDisabled?.();
    if (this.#stopping || paused) {
      // Mid-restart, or the kill switch: leave the inbox for the sweeper of a host that may run turns.
      await pool.query("UPDATE orbit_conversations SET interrupted = true WHERE id = $1", [
        conversationId,
      ]);
      if (paused) this.#o.onEvent(conversationId, { type: "failed", message: paused });
      return;
    }
    const conversation = await getConversation(pool, conversationId);
    if (!conversation) return;
    let sticky = this.#live.get(conversationId);
    // A worker on its way out can't take the turn; wait until it's gone (or decided to stay).
    if (sticky?.releasing) {
      await sticky.releasing.done;
      sticky = this.#live.get(conversationId);
    }
    // A turn already running here takes new messages when it ends.
    if (sticky?.turn) return;
    const holder = sticky?.holder ?? `${this.#o.hostId}/${randomUUID()}`;

    let leaseGen: number;
    try {
      leaseGen = await withTransaction(pool, async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO orbit_live_loops (user_sub, conversation_id, holder, expires_at)
            VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')
            ON CONFLICT (user_sub) DO UPDATE
              SET conversation_id = EXCLUDED.conversation_id, holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
              WHERE orbit_live_loops.expires_at <= now() OR orbit_live_loops.conversation_id = EXCLUDED.conversation_id`,
          [conversation.ownerSub, conversationId, this.#o.hostId, this.#o.lease.maxTurnMs],
        );
        if (rowCount === 0) throw new Busy("the user's loop");
        const gen = await acquireLeaseInTransaction(
          client,
          conversation.storeId,
          holder,
          this.#o.lease.ttlMs,
        );
        if (gen === undefined) throw new Busy("the lease");
        // Marked for as long as the turn lasts, so a host killed outright (no exit handlers, no
        // shutdown) still leaves the conversation for the next host's sweeper. A pause ends here.
        await client.query(
          "UPDATE orbit_conversations SET interrupted = true, paused = false WHERE id = $1",
          [conversationId],
        );
        return gen;
      });
    } catch (error) {
      if (!(error instanceof Busy)) throw error;
      // Never wait on the other conversation here: the job slot would be held for its whole turn.
      if (!job.attempt) this.#o.onEvent(conversationId, { type: "waiting" });
      await this.#retry(job, "busy");
      return;
    }

    const release = () => this.#releaseLoop(conversation.ownerSub, conversationId);
    if (sticky && sticky.leaseGen !== leaseGen) {
      // The store changed hands since this worker opened it, so its storage is fenced out. Start
      // over under a fresh holder once it's gone, rather than reuse its name.
      await release();
      await sticky.worker.terminate();
      await this.#retry(job, "busy");
      return;
    }
    if (this.#stopping) {
      await release();
      await pool.query("UPDATE orbit_conversations SET interrupted = true WHERE id = $1", [
        conversationId,
      ]);
      return;
    }
    try {
      let live: Live | undefined = sticky;
      if (!live) {
        const booted = await this.#boot(conversation, holder, leaseGen);
        live = booted;
        // An interrupted run picked up again is this turn's work, before any new message.
        if (booted.resuming) {
          const resumed = this.#startTurn(live);
          resumed.running = true;
          await this.#untilSettledOrAsking(live, resumed);
          return;
        }
      }
      const turn = this.#startTurn(live);
      if (!(await this.#submitInbox(live))) {
        this.#endTurn(live, "settled");
        return;
      }
      await this.#untilSettledOrAsking(live, turn);
    } catch (error) {
      // Nothing scheduled would pick the inbox up again, so the turn is retried, and a restart
      // finds it marked.
      this.#o.log?.(`turn for ${conversationId} failed: ${(error as Error).message}`);
      const live = this.#live.get(conversationId);
      if (live?.turn) this.#endTurn(live, "interrupted");
      else await release();
      await pool.query("UPDATE orbit_conversations SET interrupted = true WHERE id = $1", [
        conversationId,
      ]);
      await this.#retry(job, "failed");
    }
  }

  /** The handler's wait: until the run settles, or until it asks the user, who may take a while. */
  async #untilSettledOrAsking(live: Live, turn: Turn): Promise<void> {
    const asking =
      live.asks.size > 0 ? Promise.resolve() : this.#next(live, "ask").then(() => undefined);
    asking.catch(() => undefined);
    await Promise.race([turn.done, asking]);
  }

  #startTurn(live: Live): Turn {
    let end!: () => void;
    const done = new Promise<void>((resolve) => (end = resolve));
    const turn: Turn = { done, end, running: false };
    // The turn cap, paused while the run waits on the user: approvals pause instead of timing out.
    const arm = (ms: number) => {
      turn.cap = setTimeout(() => {
        if (live.asks.size > 0) arm(30_000);
        else {
          live.retired = true;
          void live.worker.terminate();
        }
      }, ms);
    };
    arm(this.#o.lease.maxTurnMs);
    live.turn = turn;
    return turn;
  }

  /**
   * End the conversation's turn: release the user's live loop, record whether it finished or was
   * cut off, and send the next turn if messages came while it ran.
   */
  #endTurn(live: Live, how: "settled" | "interrupted"): void {
    const turn = live.turn;
    if (!turn) return;
    clearTimeout(turn.cap);
    live.turn = undefined;
    live.quietSince = Date.now();
    turn.end();
    const { pool } = this.#o;
    const id = live.conversationId;
    // However the close settles the run, a pause waits for the user rather than the sweeper.
    const paused = live.releasing?.why === "pause";
    live.ending = this.#track(async () => {
      await this.#releaseLoop(live.sub, id);
      // A restart's close settles the run as aborted; it still has to resume on the next host.
      const interrupted = !paused && (how === "interrupted" || this.#stopping);
      await pool.query(
        "UPDATE orbit_conversations SET interrupted = $2, paused = $3 WHERE id = $1",
        [id, interrupted, paused],
      );
      if (!this.#stopping && !this.#handling.has(id) && (await this.#hasInbox(id)))
        await this.#send({ conversationId: id });
    }, `ending the turn for ${id}`);
  }

  #track(work: () => Promise<unknown>, what: string): Promise<unknown> {
    const running = work()
      .catch((error: Error) => this.#o.log?.(`${what} failed: ${error.message}`))
      .finally(() => this.#settling.delete(running));
    this.#settling.add(running);
    return running;
  }

  #releaseLoop(sub: string, conversationId: string): Promise<unknown> {
    return this.#o.pool.query(
      "DELETE FROM orbit_live_loops WHERE user_sub = $1 AND conversation_id = $2 AND holder = $3",
      [sub, conversationId, this.#o.hostId],
    );
  }

  async #hasInbox(conversationId: string): Promise<boolean> {
    const { rowCount } = await this.#o.pool.query(
      "SELECT 1 FROM orbit_inbox WHERE conversation_id = $1 LIMIT 1",
      [conversationId],
    );
    return (rowCount ?? 0) > 0;
  }

  async #boot(
    conversation: ConversationRow,
    holder: string,
    leaseGen: number,
  ): Promise<Live & { resuming: boolean }> {
    const { pool } = this.#o;
    const pageId = conversation.pageId ?? (await this.#o.pageFor(conversation));
    if (conversation.pageId === null) {
      await pool.query("UPDATE orbit_conversations SET page_id = $2 WHERE id = $1", [
        conversation.id,
        pageId,
      ]);
    }
    const data: WorkerData = {
      storeId: conversation.storeId,
      leaseGen,
      ...(conversation.durableConversationId
        ? { conversationId: conversation.durableConversationId }
        : {}),
      database: this.#o.databaseUrl,
      galaxyUrl: this.#o.galaxyUrl,
      pageId,
      model: this.#o.modelFor(conversation.ownerSub),
      limits: this.#o.limits,
      ...(this.#o.compileCache ? { compileCache: this.#o.compileCache } : {}),
    };
    const worker = (this.#o.spawn ?? spawnWorker)(this.#o.bundle, data);
    const live: Live = {
      conversationId: conversation.id,
      sub: conversation.ownerSub,
      storeId: conversation.storeId,
      holder,
      leaseGen,
      worker,
      asks: new Map(),
      waiters: new Set(),
      exited: false,
      quietSince: Date.now(),
    };
    this.#live.set(conversation.id, live);
    worker.on("message", (message: FromWorker) => this.#onMessage(live, message));
    worker.on("error", (error) =>
      this.#o.log?.(`worker for ${conversation.id} failed: ${error.message}`),
    );
    worker.once("exit", (code) =>
      this.#track(() => this.#onExit(live, code), `the exit of ${conversation.id}'s worker`),
    );

    const ready = (await this.#next(live, "ready")) as Extract<FromWorker, { type: "ready" }>;
    if (conversation.durableConversationId === null) {
      await pool.query(
        "UPDATE orbit_conversations SET durable_conversation_id = $2 WHERE id = $1",
        [conversation.id, ready.conversationId],
      );
    }
    live.renew = setInterval(() => {
      renewLease(pool, live.storeId, holder, this.#o.lease.ttlMs).then(
        (held) => {
          if (held) return;
          live.retired = true;
          void worker.terminate();
        },
        (error: Error) =>
          this.#o.log?.(`lease renewal for ${conversation.id} failed: ${error.message}`),
      );
      // A turn that runs (or waits on the user) keeps the user's live loop for as long as it lasts.
      if (live.turn) {
        void pool
          .query(
            "UPDATE orbit_live_loops SET expires_at = now() + $4 * interval '1 millisecond' WHERE user_sub = $1 AND conversation_id = $2 AND holder = $3",
            [live.sub, live.conversationId, this.#o.hostId, this.#o.lease.maxTurnMs],
          )
          .catch(() => undefined);
      }
    }, this.#o.lease.renewMs);
    return Object.assign(live, { resuming: ready.resuming });
  }

  /**
   * Hand the inbox to the worker as one input; false when the inbox was empty. Messages are deleted
   * once the worker has taken them into its durable inbox.
   */
  async #submitInbox(live: Live): Promise<boolean> {
    const { rows } = await this.#o.pool.query<{ id: string; text: string }>(
      "SELECT id, text FROM orbit_inbox WHERE conversation_id = $1 ORDER BY id",
      [live.conversationId],
    );
    if (rows.length === 0) return false;
    const text = rows.map((r) => r.text).join("\n\n");
    // Busy with a run Orbit started (a greeting, an auto-resume follow-up): let it finish, then retry.
    for (let attempt = 0; ; attempt++) {
      live.worker.postMessage({ cmd: "submit", text });
      const ack = (await this.#next(live, "submitted")) as Extract<
        FromWorker,
        { type: "submitted" }
      >;
      if (ack.admitted) {
        if (live.turn) live.turn.running = true;
        await this.#o.pool.query("DELETE FROM orbit_inbox WHERE id = ANY($1::bigint[])", [
          rows.map((r) => r.id),
        ]);
        return true;
      }
      if (attempt >= 20) throw new Error(`Conversation ${live.conversationId} stayed busy`);
      // The run in the way may have settled just before the refusal came back, so don't wait on
      // its settled alone.
      const settled = this.#next(live, "settled");
      settled.catch(() => undefined);
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  }

  #onMessage(live: Live, message: FromWorker): void {
    switch (message.type) {
      case "token":
        void answerTokenRequest({
          sub: live.sub,
          storeId: live.storeId,
          leaseGen: live.leaseGen,
          db: this.#o.pool,
          tokens: this.#o.tokens,
        }).then((answer) => live.worker.postMessage({ cmd: "token", id: message.id, ...answer }));
        return;
      case "ask":
        live.asks.set(message.id, { request: message.request, at: Date.now() });
        break;
      case "ask-withdrawn":
        live.asks.delete(message.id);
        break;
      case "settled":
        if (live.turn?.running) this.#endTurn(live, "settled");
        this.#crashes.delete(live.conversationId);
        break;
      case "report":
        this.#o.log?.(`conversation ${live.conversationId}: ${message.message}`);
        return;
      case "reach":
        return;
      case "not-quiet": {
        // Work in hand after all (a background task, a token wait); the quiet period starts over.
        const releasing = live.releasing;
        live.releasing = undefined;
        live.quietSince = Date.now();
        clearTimeout(releasing?.timer);
        releasing?.end();
        return;
      }
    }
    for (const waiter of [...live.waiters]) {
      if (waiter.type !== message.type) continue;
      live.waiters.delete(waiter);
      waiter.resolve(message);
    }
    if (message.type !== "submitted" && message.type !== "closed")
      this.#o.onEvent(live.conversationId, message);
  }

  async #onExit(live: Live, code: number): Promise<void> {
    live.exited = true;
    clearInterval(live.renew);
    if (this.#live.get(live.conversationId) === live) this.#live.delete(live.conversationId);
    for (const waiter of live.waiters) waiter.reject(new Error(`The worker exited with ${code}`));
    live.waiters.clear();
    const { pool } = this.#o;
    // Paused on purpose: it waits for the user, not the sweeper or a crash retry.
    const pausing = live.releasing?.why === "pause" && code !== LEASE_LOST_EXIT_CODE;
    // Cut off mid-turn (a crash, the turn cap, a restart) or holding an ask: resume it later. A lost
    // lease means another host has the conversation, and it's theirs to resume.
    const cutOff = live.turn !== undefined || live.asks.size > 0;
    if (cutOff && !pausing && code !== LEASE_LOST_EXIT_CODE) {
      await pool
        .query("UPDATE orbit_conversations SET interrupted = true WHERE id = $1", [
          live.conversationId,
        ])
        .catch(() => undefined);
    }
    // Let the next worker take the lease without waiting out the TTL; its acquire still bumps. Before
    // the turn ends, since ending it sends any waiting message's turn, which would otherwise find the
    // lease held and tell the user it's waiting on another conversation.
    await releaseLease(pool, live.storeId, live.holder).catch(() => undefined);
    if (pausing) {
      if (live.turn) this.#endTurn(live, "interrupted");
      else {
        // The close settled the run (and ended the turn) before the exit; make sure the pause stuck.
        await live.ending;
        await pool
          .query(
            "UPDATE orbit_conversations SET interrupted = false, paused = true WHERE id = $1",
            [live.conversationId],
          )
          .catch(() => undefined);
      }
    } else if (cutOff) {
      if (code === LEASE_LOST_EXIT_CODE) {
        const turn = live.turn;
        live.turn = undefined;
        clearTimeout(turn?.cap);
        turn?.end();
        await this.#releaseLoop(live.sub, live.conversationId).catch(() => undefined);
      } else {
        this.#endTurn(live, "interrupted");
        // A crash (a dropped database connection, an uncaught error) resumes the run on a fresh
        // worker now, as the notice tells the user, rather than at their next message.
        if (!this.#stopping && !live.retired) {
          const attempt = (this.#crashes.get(live.conversationId) ?? 0) + 1;
          this.#crashes.set(live.conversationId, attempt);
          await this.#retry({ conversationId: live.conversationId, attempt }, "failed").catch(
            (error: Error) =>
              this.#o.log?.(`resuming ${live.conversationId} failed: ${error.message}`),
          );
        }
      }
    }
    const releasing = live.releasing;
    if (releasing) {
      clearTimeout(releasing.timer);
      // After the turn's own bookkeeping, so the turn waiting on this release isn't undone by it.
      await live.ending;
      releasing.end();
      return;
    }
    this.#o.onEvent(live.conversationId, { type: "worker-exit", code });
  }

  /** Release workers that have sat quiet long enough, and pause conversations whose confirm waits too long. */
  #idleCheck(settings: IdleSettings): void {
    if (this.#stopping) return;
    const now = Date.now();
    for (const live of this.#live.values()) {
      if (live.exited || live.releasing) continue;
      const watched = this.#o.watched?.(live.conversationId) ?? false;
      if (watched) live.quietSince = now;
      const asked = [...live.asks.values()].map((a) => a.at);
      const action = idleAction(
        {
          busy: live.turn !== undefined || this.#handling.has(live.conversationId),
          oldestAskAt: asked.length ? Math.min(...asked) : undefined,
          watched,
          quietSince: live.quietSince,
        },
        now,
        settings,
      );
      if (action) this.#release(live, action === "pause" ? "pause" : "idle");
    }
  }

  /**
   * Close a worker on purpose. Idle release asks the worker to close only at a quiet point; a pause
   * closes it outright, which rejects the pending ask after the harness is sealed (the gate pause
   * contract), so the call asks again when the conversation resumes.
   */
  #release(live: Live, why: "idle" | "pause"): void {
    let end!: () => void;
    const done = new Promise<void>((resolve) => (end = resolve));
    live.releasing = { why, done, end };
    this.#o.log?.(`${why === "pause" ? "pausing" : "releasing"} ${live.conversationId}`);
    if (why === "pause") {
      live.retired = true;
      this.#o.onEvent(live.conversationId, { type: "paused" });
    }
    live.worker.postMessage({ cmd: why === "pause" ? "close" : "release" });
    // A worker that doesn't finish closing is ended; recovery on the next boot covers what it held.
    live.releasing.timer = setTimeout(() => void live.worker.terminate(), 10_000);
  }

  #next(live: Live, type: FromWorker["type"]): Promise<FromWorker> {
    if (live.exited) return Promise.reject(new Error("The worker has exited"));
    return new Promise((resolve, reject) => live.waiters.add({ type, resolve, reject }));
  }
}
