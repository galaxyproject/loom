/**
 * The durable watch under Orbit's brain: one pi-durable task per conversation, the worker's only
 * clock. Orbit's poller has no timer in the worker (slice 3, commit 5); this task drives it.
 *
 * Each tick polls through Orbit (`pollGalaxyNow`), which advances the record's blocks by the
 * record's own key and reports the ledger's undelivered transitions. The tick posts each one to
 * the page, writes down the follow-up it is about to hand over, hands the conversation Orbit's
 * follow-up text under that request id, then marks those transitions delivered. Re-running any
 * step after a crash is safe: the poller's writes are compare-and-swap, a replayed follow-up
 * reuses the request id it wrote down, and the page drops a Settled it has shown. The watch ends
 * once nothing is in flight, waiting on enrichment, sent and uncaptured, or undelivered: the
 * ledger is the capture barrier, so a capture that takes several ticks keeps it alive.
 *
 * For a conversation the page isn't showing, it keeps the record current through `background`
 * (a tick pinned to that record: blocks move, nothing is announced or followed up) for as long as
 * work is in flight, then waits for the conversation to be shown again with no timer and no
 * commits. The follow-up waits in the ledger and goes out on the first tick after the show.
 */
import {
  defineDoc,
  defineTask,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";

import type { PollOptions, TickResult } from "../../../../../extensions/orbit/galaxy-poller";
import type { TerminalEvent } from "../../../../../extensions/orbit/submission-ledger";
import { FollowUps, heldBy } from "../documents";
import { pollDelay, type Settled } from "../watch";

/** The task's name, shared with the default brain's watch: the page and drives know it by it. */
export const ORBIT_WATCH = "olit.galaxy-watch";

/**
 * The conversation's watch task, when it has one; whether its next tick should first capture
 * what the ledger holds answered and reconcile (the first tick after the conversation is shown);
 * and whether new work arrived since a tick polled, so that tick neither ends nor keeps its
 * backoff. `active` mirrors whether `taskId` names a live task, for readers outside a commit.
 */
export const Watching = defineDoc<{
  active: boolean;
  recover: boolean;
  fresh?: boolean;
  /** pi-durable's id for the task, kept as it gives it. */
  taskId?: TaskId;
}>({
  kind: "olit.watching",
  // 2: taskId, without which a watch made before it would be doubled by the first ensure.
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ active: false, recover: false }),
});

export interface OrbitWatchOptions {
  /** Whether the page shows this conversation now, so Orbit's poller works on its record. */
  bound(conversationId: ConversationId): boolean;
  /** The record key Orbit's poller pins for this conversation. */
  recordKey(conversationId: ConversationId): string;
  poll(options: PollOptions): Promise<TickResult>;
  /**
   * One tick on an unshown conversation's record, and whether it still has work in flight; without
   * it, an unshown conversation's record waits for the show.
   */
  background?(conversationId: ConversationId): Promise<boolean>;
  delivered(recordKey: string, keys: readonly string[]): Promise<void>;
  /** Tell the page some watched work settled. */
  settled(conversationId: ConversationId, settled: Settled): void;
  /**
   * Resolves when something asked this conversation's watch to look now. A wake asked for while
   * nobody was waiting counts: it resolves the next call at once. `signal` ends the wait without
   * a wake, and a later wake is then kept for the next one.
   */
  woken(conversationId: ConversationId, signal?: AbortSignal): Promise<void>;
  pollMs?: number;
}

type WatchInput = { conversationId: ConversationId };
/** A follow-up written down before it is handed over, so a replay hands over the same one. */
type Pending = { requestId: string; prompt: string; keys: string[]; queue: boolean };
/**
 * `ticks` only grows, so every commit is progress to pi-durable (a checkpoint that comes back
 * unchanged faults the task); `backoff` is the wait's step, which new or settled work resets.
 */
type WatchState = { phase: "tick"; ticks: number; backoff?: number; pending?: Pending };

/** A ledger event as the page's Settled: the browser brain's shape, which shell.ts renders. */
export function settledOf(event: TerminalEvent): Settled {
  // "failing" is a mid-flight failure: some jobs failed and the invocation runs on.
  const state = event.outcome === "failing" ? "failing" : event.to;
  return {
    watched: { kind: event.kind, id: event.id, label: event.label, state },
    state,
    outcome: event.outcome === "failing" ? "failed" : (event.outcome as Settled["outcome"]),
  };
}

/**
 * Wakes for each conversation's watch. A wake with nobody waiting (it landed mid-tick, say) is
 * kept, and resolves the next wait at once; a wait that ended some other way stops waiting.
 */
export function wakeups() {
  const waiting = new Map<ConversationId, () => void>();
  const early = new Set<ConversationId>();
  return {
    wake(id: ConversationId) {
      const resolve = waiting.get(id);
      waiting.delete(id);
      if (resolve) resolve();
      else early.add(id);
    },
    woken(id: ConversationId, signal?: AbortSignal): Promise<void> {
      if (early.delete(id)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiting.set(id, resolve);
        signal?.addEventListener(
          "abort",
          () => {
            if (waiting.get(id) === resolve) waiting.delete(id);
          },
          { once: true },
        );
      });
    },
  };
}

/** The watch definition's version: a record of another one can't run under this one. */
const VERSION = 3;
/** A task that will still run: one waiting its turn, or running now. */
const LIVE = new Set(["pending", "running"]);

export function orbitWatch(options: OrbitWatchOptions) {
  const pollMs = options.pollMs ?? 10_000;

  /** Until `ms` pass (never, without one), a wake, or the invocation ending. */
  const pause = (id: ConversationId, ms: number | undefined, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const ended = new AbortController();
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        // A wait that ended by timer or abort stops listening, so the next wake is kept.
        ended.abort();
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
      void options.woken(id, ended.signal).then(done);
    });

  const task = defineTask<WatchInput, WatchState, { ticks: number }>({
    name: ORBIT_WATCH,
    version: VERSION,
    initial: () => ({ phase: "tick", ticks: 0, backoff: 0 }),
    phases: {
      tick: async (current, runtime, context) => {
        const id = current.input.conversationId;
        const checkpoint = current.state.checkpoint as WatchState;
        // Until the page shows it: the record kept current while its work runs, then no timer and
        // no commits, just the wake an attach sends.
        for (let polls = 0; !options.bound(id);) {
          if (runtime.signal.aborted) return;
          let busy = false;
          try {
            busy = (await options.background?.(id)) ?? false;
          } catch (error) {
            runtime.report(error);
            busy = true;
          }
          await pause(id, busy ? pollDelay(++polls, pollMs) : undefined, runtime.signal);
        }
        /** The next checkpoint, from the task as it stands now: ticks always move on. */
        const next = (now: { state: { checkpoint: unknown } }, change: Partial<WatchState>) => {
          const at = now.state.checkpoint as WatchState;
          return { ...at, ...change, phase: "tick" as const, ticks: at.ticks + 1 };
        };
        const handOver = async (pending: Pending) => {
          const conversation = await runtime.conversation(id, context);
          if (!conversation) {
            runtime.report(
              new Error(`watch: conversation ${String(id)} is gone; its follow-up is dropped`),
            );
          }
          await conversation?.submit(
            {
              type: "input",
              content: pending.prompt,
              requestId: pending.requestId,
              ...(pending.queue ? { whenIdle: "queue" as const } : {}),
            },
            context,
          );
          await options.delivered(options.recordKey(id), pending.keys);
        };
        let backoff = checkpoint.backoff ?? 0;
        try {
          // A follow-up a tick wrote down and didn't live to finish handing over.
          if (checkpoint.pending) {
            await handOver(checkpoint.pending);
            await runtime.commit(
              (_tx, now) => ({ status: "running", checkpoint: next(now, { pending: undefined }) }),
              context,
            );
          }
          const watching = await runtime.snapshot(Watching, id, context);
          const recover = watching?.recover === true;
          const result = await options.poll({
            awaitEnrichment: true,
            ...(recover ? { reconcile: true, recover: true } : {}),
          });
          let quiet = false;
          // A tick that ran against another record (the page switched mid-tick) says nothing here.
          if (result.recordKey === options.recordKey(id)) {
            for (const event of result.transitions) options.settled(id, settledOf(event));
            const keys = result.transitions.map((t) => t.key);
            if (result.resumePrompt && keys.length) {
              const held = heldBy(await runtime.snapshot(FollowUps, id, context)) !== undefined;
              const pending: Pending = {
                requestId: `watch:${id}:${keys.join(",")}`,
                prompt: result.resumePrompt,
                keys,
                queue: held,
              };
              await runtime.commit(async (tx, now) => {
                if (!held) (await tx.doc(FollowUps, id)).automatic += 1;
                return { status: "running", checkpoint: next(now, { pending }) };
              }, context);
              await handOver(pending);
            } else if (keys.length) {
              await options.delivered(result.recordKey, keys);
            }
            // Settled work starts the backoff over: what follows tends to be more work.
            if (keys.length) backoff = 0;
            quiet =
              result.inProgress === 0 &&
              result.pendingEnrichment === 0 &&
              result.openSubmissions === 0;
          }
          let ended = false;
          let step = backoff + 1;
          await runtime.commit(async (tx, now) => {
            const doc = await tx.doc(Watching, id);
            if (recover) doc.recover = false;
            // New work arrived after this tick polled: it isn't quiet after all. Computed afresh
            // on each call: pi-durable may run this more than once.
            const fresh = doc.fresh === true;
            doc.fresh = false;
            step = fresh ? 1 : backoff + 1;
            if (quiet && !fresh) {
              ended = true;
              Object.assign(doc, { active: false, taskId: undefined });
              const at = now.state.checkpoint as WatchState;
              return {
                status: "terminal",
                outcome: { status: "completed", result: { ticks: at.ticks + 1 } },
              };
            }
            return {
              status: "running",
              checkpoint: next(now, { pending: undefined, backoff: step }),
            };
          }, context);
          if (ended) return;
          backoff = step;
        } catch (error) {
          // A tick that fails (a ledger write refused, Galaxy down) is retried, not given up on:
          // a faulted watch would leave the conversation unwatched. Its checkpoint keeps a
          // follow-up the tick wrote down.
          if (runtime.signal.aborted) return;
          runtime.report(error);
          const step = backoff + 1;
          try {
            await runtime.commit(async (tx, now) => {
              (await tx.doc(Watching, id)).fresh = false;
              return { status: "running", checkpoint: next(now, { backoff: step }) };
            }, context);
          } catch (refused) {
            // Without that commit the phase can't return without faulting anyway: fault now, with
            // the cause, rather than after a backoff. The next ensure replaces the watch.
            if (runtime.signal.aborted) return;
            runtime.report(refused);
            throw refused;
          }
          backoff = step;
        }
        // pi-durable runs the phase again once its checkpoint has moved, as it has above.
        await pause(id, pollDelay(backoff, pollMs), runtime.signal);
      },
    },
    abort: async (current, runtime, context) => {
      await runtime.commit(async (tx) => {
        Object.assign(await tx.doc(Watching, current.input.conversationId), {
          active: false,
          taskId: undefined,
        });
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });

  /**
   * Make sure the conversation has a watch, in the caller's transaction: a submission's execute,
   * or the worker showing the conversation (with `recover`, so the first tick captures and
   * reconciles). A watch is live when the task its doc names is; one that faulted, or a doc that
   * says active with no task behind it, gets a new watch.
   */
  async function ensure(tx: Tx, conversationId: ConversationId, { recover = false } = {}) {
    const doc = await tx.doc(Watching, conversationId);
    if (recover) doc.recover = true;
    const known = doc.taskId !== undefined ? await tx.task(doc.taskId) : undefined;
    // A record from another version of this definition is never scheduled again (pi-durable
    // blocks it without a migrate), so it doesn't count as live.
    const live =
      known !== undefined &&
      (known as { version?: number }).version === VERSION &&
      LIVE.has((known.state as { status: string }).status);
    if (live) {
      // A live watch: new work keeps it from ending and starts its backoff over.
      doc.fresh = true;
      return;
    }
    const taskId = await tx.createTask(
      task,
      { conversationId },
      {
        ownership: { kind: "conversation" },
        conversationId,
        // Outlives a Stop or a switch: the work it watches goes on in Galaxy.
        background: true,
      },
    );
    Object.assign(doc, { active: true, fresh: false, taskId });
  }

  return { task, ensure };
}
