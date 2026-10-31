/**
 * Background poller for active Galaxy workflow invocations.
 *
 * Part 2 of #67. Part 1 added the YAML counters + the Activity-tab UI
 * section that draws progress bars from them. This file is the timer
 * that keeps those counters fresh between agent turns: every
 * POLL_INTERVAL_MS, scan the notebook for in-flight blocks; if any
 * exist, run `checkInvocations` to advance status and write updated
 * counters back to notebook.md.
 *
 * Lifecycle:
 *   - session_start → startGalaxyPoller(): unconditionally start the
 *     timer. Each tick is cheap when no blocks are in-flight (one
 *     notebook read + scan, no Galaxy call).
 *   - session_shutdown → stopGalaxyPoller(): clear timer.
 *   - Multiple session_start (brain restart) → start() stops any prior
 *     timer first; idempotent.
 *   - Under the browser worker (`ui: "worker"`) start() arms nothing: the
 *     worker's durable watch calls pollGalaxyNow() and reads its TickResult.
 *
 * Why "always running" instead of stopping on idle:
 *   If we stopped at "no in-flight blocks", the next time the agent
 *   recorded a new invocation mid-session we'd never wake up — only
 *   another session_start would. Avoids a circular import between
 *   tools.ts (which records invocations) and this file. The cost is
 *   one notebook read + scan per 15s, which is negligible.
 *
 * Concurrency: ticks are guarded by `inFlight` so a slow Galaxy GET
 * doesn't stack ticks. The check itself uses the existing per-notebook
 * lock in withNotebookLock, so a manual `galaxy_invocation_check_all`
 * call from the agent doesn't race the poller.
 */

import * as path from "path";
import { getNotebookPath } from "./state.js";
import {
  findInvocationBlocks,
  NotebookChangedError,
  readNotebook,
  statNotebook,
  withNotebookLock,
  writeNotebook,
} from "./notebook-writer.js";
import {
  checkInvocations,
  isInvocationLive,
  type CheckResultEntry,
  type InvocationPersistHooks,
} from "./tools.js";
import {
  getGalaxyConfig,
  galaxyGetInvocation,
  galaxyGetJobDetails,
  sameGalaxyServer,
} from "./galaxy-api.js";
import { buildResumePrompt, isResumableOutcome, type GalaxyFollowUp } from "./auto-resume.js";
import {
  applyJobPollUpdate,
  findJobBlocks,
  isTerminalJobState,
  jobStatusFromGalaxyState,
  type JobYaml,
} from "./galaxy-job-block.js";
import { appendActivityEvent } from "./activity.js";
import { recoverSubmissions } from "./galaxy-submission-capture.js";
import {
  isClosedSubmission,
  submissionLedger,
  terminalEventKey,
  type TerminalEvent,
  type TerminalEventInput,
} from "./submission-ledger.js";
import { capabilityProfile } from "../../shared/capability-profile.js";

// 15s — ~4 polls/min × a few in-flight invocations stays well under
// usegalaxy.org's per-user rate budget while still feeling live. Background
// GETs never invoke the model, so this is independent of the model-facing
// status-read cooldown in galaxy-poll-guard.ts.
const POLL_INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
/**
 * The tick currently running, if any. Ticks don't stack -- a slow Galaxy GET
 * would otherwise let the interval pile them up -- and holding the promise
 * rather than a boolean lets a caller wait for the one already in flight.
 */
let inFlightTick: Promise<TickRun> | null = null;
/** The record the running tick was pinned to, if a caller named one, and the record it runs on. */
let inFlightPinned: string | undefined;
let inFlightKey: string | null = null;
/**
 * Bumped by every startGalaxyPoller. A tick that spans a session switch still
 * writes by the record key it pinned, but finds this moved and leaves the new
 * session's tracking, toasts and follow-ups alone.
 */
let generation = 0;

/** Under the browser worker the durable watch drives every tick; nothing here keeps time. */
function underWorker(): boolean {
  return capabilityProfile().ui === "worker";
}

export interface PollOptions {
  /** Wait for this tick's enrichment (and reconcile, when asked) instead of leaving it running. */
  awaitEnrichment?: boolean;
  /** Run a reconcile pass inside this tick. */
  reconcile?: boolean;
  /** Capture answered submissions that never got a block before polling. */
  recover?: boolean;
  /**
   * Poll this record rather than the bound one: a shell keeping an unshown conversation's record
   * current. Its blocks move and its events are confirmed, but nothing is announced or delivered
   * until the record is bound again.
   */
  recordKey?: string;
}

/** What one tick left behind, for a caller that drives the polling itself. */
export interface TickResult {
  /** The record this tick ran against; a caller for another record should discard the result. */
  recordKey: string | null;
  /** The record's undelivered terminal events: this tick's, and any a dead tick never announced. */
  transitions: TerminalEvent[];
  inProgress: number;
  pendingEnrichment: number;
  /** Submissions sent and not yet captured or reconciled. */
  openSubmissions: number;
  /** The follow-up turn for those transitions, when any of them warrants one. */
  resumePrompt?: string;
}

interface TickRun {
  recordKey: string | null;
  transitions: TerminalEvent[];
}

/** Surface a toast to the shell when a background invocation finishes. */
type PollerNotify = (text: string, level: "info" | "warning" | "error") => void;
let notify: PollerNotify | null = null;

/**
 * Extra work to run on each tick, handed the notebook this tick already read.
 *
 * One hook rather than a second `setInterval`, because everything a second
 * timer would need is already here: the cadence, the notebook read, and the
 * knowledge of what is in flight. A second timer would also be a second thing
 * to remember to stop. The live Galaxy panel registers through this.
 */
type PollTickHook = (content: string | null) => Promise<void>;
let tickHook: PollTickHook | null = null;

export function setPollTickHook(hook: PollTickHook | null): void {
  tickHook = hook;
}

/** For tests: whether anything is registered, and what. */
export function getPollTickHook(): PollTickHook | null {
  return tickHook;
}

/**
 * Capture's per-tick work: enrichment of finished runs, and a reconcile every
 * few ticks (galaxy-reconcile.ts). Separate from `tickHook` because it has a
 * different place in the tick -- it runs after this tick's transitions have
 * landed, so a run that just finished is enriched on the same tick -- and
 * because the live panel already owns that slot. Not awaited, for the same
 * reason the panel hook isn't: a slow details fetch must not hold up polling.
 * The exception is a caller that drives the ticks itself and asks to wait
 * (`wait`), or asks for a reconcile inside the tick (`reconcile`).
 */
type CaptureTickHook = (
  tickNumber: number,
  options: { reconcile: boolean; wait: boolean },
) => Promise<void>;
let captureHook: CaptureTickHook | null = null;
let tickCount = 0;

export function setCaptureTickHook(hook: CaptureTickHook | null): void {
  captureHook = hook;
}

/**
 * Hand a finished run back to the agent as a queued follow-up, so it verifies
 * outputs itself instead of the toast asking the user to relay. Null when
 * auto-resume is explicitly disabled.
 *
 * Must queue rather than interrupt: delivering a prompt to a brain that is
 * mid-turn fails outright with "Agent is already processing".
 */
type PollerResume = (text: string) => void;
let resume: PollerResume | null = null;

/** Whether a finished run will be handed back: by resume here, or by the worker's durable watch. */
function followUpsOn(): boolean {
  return resume !== null || underWorker();
}

function notifySafely(text: string, level: "info" | "warning" | "error"): void {
  try {
    notify?.(text, level);
  } catch (err) {
    // A stale shell must not prevent the agent from receiving its follow-up.
    console.error("[galaxy-poller] notification failed:", err);
  }
}

/** Subset of a checkInvocations result entry the poller needs for notifications. */
interface PollResultEntry {
  invocationId: string;
  notebookAnchor?: string;
  label?: string;
  priorStatus?: string;
  jobSummary?: { ok?: number; running?: number; queued?: number; error?: number; other?: number };
  activeJobs?: number;
  newStatus?: string;
  lastPolledAt?: string;
  autoAction?: string;
}

/**
 * Record a status change in the session's activity log.
 *
 * The poller calls checkInvocations directly rather than through the tool
 * dispatcher, so every transition it made — the ones the user sees as a toast
 * and a rewritten block — used to leave no row behind at all. This is the audit
 * trail for work that advances between turns, with nobody watching.
 */
function logTransition(nbPath: string, payload: Record<string, unknown>): void {
  appendActivityEvent(path.dirname(nbPath), {
    timestamp: new Date().toISOString(),
    kind: "poll.transition",
    source: "galaxy-poller",
    payload,
  });
}

/**
 * Invocations we've already told the user about a mid-flight job failure for.
 * That one is reported from a block that stays `in_progress` on purpose (the
 * rest of the workflow is still under observation), so unlike a terminal
 * transition it recurs on every tick until the run ends — announce it once.
 * Reset per session in startGalaxyPoller.
 */
const announcedFailing = new Set<string>();

/** A block the poller has seen in flight in the notebook this session. */
interface TrackedBlock {
  kind: "invocation" | "job";
  id: string;
  label: string;
  /** Consecutive failed liveness checks after the block went missing. */
  checkFailures?: number;
}

/**
 * How many times a missing block's liveness check may fail before we give up on
 * it. A 403 or a 404 doesn't get better by asking again, and retrying forever
 * would spend a Galaxy round trip per tick, per id, for the rest of the
 * session.
 */
const MAX_MISSING_CHECK_ATTEMPTS = 3;

/**
 * Every in-flight block we've seen this session, keyed `<kind>:<id>`. The
 * notebook is the poller's only index of what to watch, so a block that leaves
 * it -- an agent edit, a `bash` rewrite, a hand-pruned file -- takes a live
 * Galaxy run out of Orbit's sight with nothing said. We can't put the block back
 * (it is the user's file, and re-inserting it would fight whoever removed it),
 * but we can refuse to let it go quietly. Reset per session in
 * startGalaxyPoller.
 */
const trackedActive = new Map<string, TrackedBlock>();

function trackKey(kind: TrackedBlock["kind"], id: string): string {
  return `${kind}:${id}`;
}

/**
 * Remember the blocks that are in flight right now, and forget the ones that
 * have reached a terminal status. What survives is exactly the set whose
 * disappearance would cost us a running job.
 */
function trackActiveBlocks(content: string): void {
  for (const inv of findInvocationBlocks(content)) {
    const key = trackKey("invocation", inv.invocationId);
    if (inv.status === "in_progress") {
      trackedActive.set(key, {
        kind: "invocation",
        id: inv.invocationId,
        label: inv.label || inv.notebookAnchor || inv.invocationId,
      });
    } else {
      trackedActive.delete(key);
    }
  }
  for (const job of findJobBlocks(content)) {
    const key = trackKey("job", job.jobId);
    if (job.status === "in_progress") {
      trackedActive.set(key, {
        kind: "job",
        id: job.jobId,
        label: job.label || job.toolId || job.jobId,
      });
    } else {
      trackedActive.delete(key);
    }
  }
}

/** Ask Galaxy whether a run whose block has vanished is still going. */
async function isStillLive(block: TrackedBlock): Promise<{ live: boolean; state?: string }> {
  if (block.kind === "invocation") {
    const inv = await galaxyGetInvocation(block.id);
    return { live: isInvocationLive(inv), state: inv.state };
  }
  const details = await galaxyGetJobDetails(block.id);
  return { live: !isTerminalJobState(details.state), state: details.state };
}

/** Say once, in the activity log and in the UI, that a live run left the notebook. */
function announceMissingBlock(
  nbPath: string,
  block: TrackedBlock,
  state: string | undefined,
): void {
  appendActivityEvent(path.dirname(nbPath), {
    timestamp: new Date().toISOString(),
    kind: "poll.block_missing",
    source: "galaxy-poller",
    payload: {
      blockKind: block.kind,
      id: block.id,
      label: block.label,
      galaxyState: state ?? null,
    },
  });
  if (notify) {
    notify(
      `⚠️ Galaxy: "${block.label}" is still ${state ?? "running"} on Galaxy, but its ${block.kind} block is gone from the notebook — Orbit has stopped tracking it.`,
      "warning",
    );
  }
}

/**
 * Compare what we're tracking against what the notebook still holds, and report
 * anything that went missing while Galaxy says the run is alive. A block that
 * disappeared after its run finished is unremarkable: it costs one GET and
 * nothing else.
 */
async function reportMissingBlocks(
  nbPath: string,
  content: string,
  current: () => boolean,
): Promise<void> {
  if (trackedActive.size === 0) return;
  const present = new Set<string>();
  for (const inv of findInvocationBlocks(content)) {
    present.add(trackKey("invocation", inv.invocationId));
  }
  for (const job of findJobBlocks(content)) present.add(trackKey("job", job.jobId));

  const missing = [...trackedActive.entries()].filter(([key]) => !present.has(key));
  if (missing.length === 0) return;
  // No credentials, no verdict: keep the ids and ask again next tick.
  if (!getGalaxyConfig()) return;

  for (const [key, block] of missing) {
    let result: { live: boolean; state?: string };
    try {
      result = await isStillLive(block);
    } catch (err) {
      // Galaxy briefly unreachable. Stay tracked and ask again next tick; one
      // unreachable id must not cost the others their check. A few attempts in,
      // stop asking -- the answer isn't coming.
      console.error(`[galaxy-poller] ${block.kind} ${block.id} liveness check failed:`, err);
      if (!current()) return;
      const failures = (block.checkFailures ?? 0) + 1;
      if (failures >= MAX_MISSING_CHECK_ATTEMPTS) trackedActive.delete(key);
      else trackedActive.set(key, { ...block, checkFailures: failures });
      continue;
    }
    // One verdict per id, either way: the block is gone, so there is nothing
    // left to re-examine. Recording it again re-arms the tracking.
    // The answer came back to a different session's poller: its tracking isn't ours to touch.
    if (!current()) return;
    trackedActive.delete(key);
    if (result.live) announceMissingBlock(nbPath, block, result.state);
  }
}

/** How many times a job update re-reads and retries before giving up the tick. */
const MAX_JOB_PERSIST_ATTEMPTS = 3;

/**
 * Persist one job's poll result, returning whether it actually landed.
 *
 * Same discipline as persistInvocationUpdates: stamp *before* the read (a stamp
 * taken after would let a write that landed in between look unchanged), apply
 * only poll-owned fields so a concurrent label edit survives, and hand the stamp
 * to writeNotebook so an out-of-band edit fails the compare-and-swap instead of
 * being silently overwritten (#391). The lock alone can't do this -- it only
 * orders Orbit's own writers, and the agent edits notebook.md directly.
 */
async function persistJobUpdate(
  nbPath: string,
  update: Parameters<typeof applyJobPollUpdate>[1],
): Promise<{ written: boolean; priorStatus?: JobYaml["status"] }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_JOB_PERSIST_ATTEMPTS; attempt++) {
    const stamp = await statNotebook(nbPath);
    // Read regardless of the stat so a genuinely missing notebook surfaces its
    // own ENOENT rather than being dressed up as a lost race.
    const fresh = await readNotebook(nbPath);
    if (!stamp) {
      lastError = new NotebookChangedError(nbPath);
      continue;
    }
    // The status as it is now, not as the tick's opening snapshot had it: the
    // write below refreshes last_polled_at either way, so "we wrote" is not the
    // same question as "we changed the outcome".
    const priorStatus = findJobBlocks(fresh).find((j) => j.jobId === update.jobId)?.status;
    const updated = applyJobPollUpdate(fresh, update);
    // Block gone, or already carrying this result: nothing to write, nothing
    // to announce.
    if (updated === fresh) return { written: false };
    try {
      await writeNotebook(nbPath, updated, stamp);
      return { written: true, priorStatus };
    } catch (error) {
      if (!(error instanceof NotebookChangedError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** The toast for a job that stopped running, matched to why it stopped. */
function jobFinishedToast(
  status: ReturnType<typeof jobStatusFromGalaxyState>,
  label: string,
  state: string | undefined,
  willResume = false,
): [string, "info" | "warning" | "error"] {
  switch (status) {
    case "completed":
      return [
        `✅ Galaxy: "${label}" finished${willResume ? " — outputs require verification." : " — automatic follow-up disabled."}`,
        "info",
      ];
    case "cancelled":
      return [`⏹️ Galaxy: "${label}" was cancelled (${state}) — it produced no outputs.`, "info"];
    case "skipped":
      return [`⏭️ Galaxy: "${label}" was skipped — its step's condition wasn't met.`, "info"];
    default:
      return [
        `❌ Galaxy: "${label}" failed (${state})${willResume ? " — failure recorded." : " — automatic follow-up disabled."}`,
        "warning",
      ];
  }
}

/** The notebook as it is right now, or null if there isn't one to read. */
async function readNotebookOrNull(nbPath: string | null): Promise<string | null> {
  if (!nbPath) return null;
  try {
    return await readNotebook(nbPath);
  } catch {
    // Notebook missing or unreadable — nothing to advance this tick.
    return null;
  }
}

function hasInProgressInvocations(content: string): boolean {
  return findInvocationBlocks(content).some((b) => b.status === "in_progress");
}

/**
 * Advance in-flight `loom-job` blocks -- single Galaxy tool runs, which have no
 * invocation to poll. One GET per in-flight job, and only for jobs that are
 * still running, so an idle notebook costs nothing beyond the scan the
 * invocation path already does.
 */
async function tickJobs(nbPath: string, content: string, current: () => boolean): Promise<void> {
  const pending = findJobBlocks(content).filter((j) => j.status === "in_progress");
  if (pending.length === 0) return;
  const currentServer = getGalaxyConfig()?.url;
  if (!currentServer) return;

  for (const job of pending) {
    let state: string | undefined;
    try {
      state = (await galaxyGetJobDetails(job.jobId)).state;
    } catch (err) {
      // One unreachable job must not stop the others, or kill the timer.
      console.error(`[galaxy-poller] job ${job.jobId} poll failed:`, err);
      continue;
    }
    if (!isTerminalJobState(state)) {
      // Still running, so there's no transition to record -- but the GET just
      // answered, which is the proof a block the record tool could only write
      // `server_verified: false` is waiting for. Without this the flag would
      // sit false for the whole run and only clear when the job ends.
      if (job.serverVerified === false && sameGalaxyServer(job.galaxyServerUrl, currentServer)) {
        try {
          await withNotebookLock(nbPath, () =>
            // Only the flag and the timestamp: this write knows nothing about
            // the outcome, and the snapshot's status is already older than
            // whatever the fresh read inside persistJobUpdate will see.
            persistJobUpdate(nbPath, {
              jobId: job.jobId,
              lastPolledAt: new Date().toISOString(),
              serverVerified: true,
            }),
          );
        } catch (err) {
          // Nothing was announced, so a lost write costs only a retry next tick.
          console.error(`[galaxy-poller] job ${job.jobId} verification update failed:`, err);
        }
      }
      continue;
    }

    const status = jobStatusFromGalaxyState(state);
    const polledAt = new Date().toISOString();
    const label = job.label || job.toolId || job.jobId;
    // Reserved before the block moves, so a crash between the write and the follow-up leaves
    // something for the next tick to find; confirmed only once the write shows it moved.
    const event = await reserve({
      recordKey: nbPath,
      kind: "job",
      id: job.jobId,
      from: job.status,
      to: status,
      outcome: status,
      label,
      notebookAnchor: job.notebookAnchor,
      detail: state,
      key: terminalEventKey("job", job.jobId, status),
    });
    if (!event) continue;
    let persisted: { written: boolean; priorStatus?: JobYaml["status"] };
    try {
      persisted = await withNotebookLock(nbPath, () =>
        persistJobUpdate(nbPath, {
          jobId: job.jobId,
          status,
          galaxyState: state,
          lastPolledAt: polledAt,
          // Only the server the block names can confirm the block's id.
          serverVerified: sameGalaxyServer(job.galaxyServerUrl, currentServer),
        }),
      );
    } catch (err) {
      // Lost the write. Say nothing and let the next tick re-poll: the block is
      // still in_progress on disk, so announcing a transition we failed to
      // record would leave the notebook and the user telling different stories.
      // The reservation stays: if the write landed after all, the next tick
      // sees the block moved and confirms it.
      console.error(`[galaxy-poller] job ${job.jobId} update failed:`, err);
      continue;
    }
    // The block was deleted mid-poll, or another writer already advanced it.
    // Either way this tick didn't transition anything, so there's no news.
    if (!persisted.written || persisted.priorStatus === status) {
      await settle(event, "void");
      continue;
    }
    await settle(event, "confirm");

    logTransition(nbPath, {
      blockKind: "job",
      id: job.jobId,
      label,
      toolId: job.toolId ?? null,
      from: persisted.priorStatus ?? job.status,
      to: status,
      galaxyState: state ?? null,
      lastPolledAt: polledAt,
    });
    if (!current()) continue;
    const willResume = followUpsOn() && isResumableOutcome(status);
    notifySafely(...jobFinishedToast(status, label, state, willResume));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal events (submission-ledger.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Reserve, or null when the ledger can't take it: then the caller leaves the job alone this tick. */
async function reserve(event: TerminalEventInput): Promise<TerminalEventInput | null> {
  try {
    await submissionLedger().reserve(event);
    return event;
  } catch (err) {
    console.error(`[galaxy-poller] ${event.kind} ${event.id} event not reserved:`, err);
    return null;
  }
}

async function settle(event: TerminalEventInput, how: "confirm" | "void"): Promise<void> {
  try {
    const ledger = submissionLedger();
    if (how === "confirm") await ledger.confirm(event.recordKey, event.key);
    else await ledger.void(event.recordKey, event.key);
  } catch (err) {
    // Left reserved: the next tick settles it against the block.
    console.error(`[galaxy-poller] ${event.kind} ${event.id} event not settled:`, err);
  }
}

/**
 * Settle what a tick that died left reserved, against what the record now says. The block shows
 * the reserved status: the write landed and nobody announced it, so confirm. Still in flight: the
 * write never happened; leave it for this tick's poll to reuse. Anything else -- gone, or ended
 * some other way -- voids it. A mid-flight failure can't be read off the block, so it is voided
 * and this tick reports it afresh.
 */
async function settleLeftovers(nbPath: string, content: string): Promise<void> {
  let leftovers: TerminalEvent[];
  try {
    leftovers = await submissionLedger().reserved(nbPath);
  } catch (err) {
    // The rest of the tick still polls; the leftovers keep until a read works.
    console.error("[galaxy-poller] reserved events not read:", err);
    return;
  }
  if (leftovers.length === 0) return;
  const statusOf = (event: TerminalEvent) =>
    event.kind === "job"
      ? findJobBlocks(content).find((j) => j.jobId === event.id)?.status
      : findInvocationBlocks(content).find((b) => b.invocationId === event.id)?.status;
  for (const event of leftovers) {
    const status = statusOf(event);
    if (status === "in_progress" && event.to !== "in_progress") continue;
    const landed = status === event.to && event.outcome !== "failing";
    await settle(event, landed ? "confirm" : "void");
    if (landed) {
      logTransition(nbPath, {
        blockKind: event.kind,
        id: event.id,
        label: event.label,
        from: event.from,
        to: event.to,
        recovered: true,
      });
    }
  }
}

/** What a follow-up turn is for: a run that finished or failed, or a workflow failing mid-flight. */
function followsUp(event: TerminalEvent): boolean {
  return isResumableOutcome(event.outcome) || event.outcome === "failing";
}

function asFollowUp(event: TerminalEvent): GalaxyFollowUp {
  return {
    kind: event.kind,
    id: event.id,
    label: event.label,
    notebookAnchor: event.notebookAnchor,
    outcome: event.outcome as GalaxyFollowUp["outcome"],
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  };
}

const RESERVED_INVOCATION_ACTIONS: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** The invocation check's persist step, held the same way as a job's. */
function invocationHooks(nbPath: string): InvocationPersistHooks {
  let reserved: { event: TerminalEventInput; failing: boolean }[] = [];
  return {
    async before(results: readonly CheckResultEntry[]) {
      reserved = [];
      for (const r of results) {
        const failing = r.autoAction === "failing" && !announcedFailing.has(r.invocationId);
        const ending = !!r.autoAction && RESERVED_INVOCATION_ACTIONS.has(r.autoAction);
        if (!failing && !ending) continue;
        const outcome = r.autoAction as string;
        const detail =
          outcome === "failed"
            ? `${r.jobSummary?.error ?? 0} job error(s)`
            : outcome === "failing"
              ? `${r.jobSummary?.error ?? 0} job(s) failed, ${r.activeJobs ?? 0} still running`
              : undefined;
        // Not the swallowing reserve: a throw here stops checkInvocations before it persists, so
        // no invocation moves without its event. The tick's catch logs it and the next retries.
        const event: TerminalEventInput = {
          recordKey: nbPath,
          kind: "invocation",
          id: r.invocationId,
          from: r.priorStatus ?? "in_progress",
          to: failing ? "in_progress" : (r.newStatus ?? outcome),
          outcome,
          label: r.label || r.notebookAnchor || r.invocationId,
          notebookAnchor: r.notebookAnchor,
          ...(detail ? { detail } : {}),
          key: terminalEventKey("invocation", r.invocationId, outcome),
        };
        await submissionLedger().reserve(event);
        reserved.push({ event, failing });
      }
    },
    async after({ applied, transitioned }) {
      for (const { event, failing } of reserved) {
        const landed = failing ? applied.has(event.id) : transitioned.has(event.id);
        await settle(event, landed ? "confirm" : "void");
      }
      reserved = [];
    },
  };
}

/** Run a poll tick now, or hand back the one already running. */
function tick(options: PollOptions = {}): Promise<TickRun> {
  const key = options.recordKey ?? getNotebookPath();
  // A pinned tick answers for its own record only, and a pinned caller wants its own: when either
  // side is pinned and the records differ, wait the running one out.
  const pinned = inFlightPinned !== undefined || options.recordKey !== undefined;
  if (inFlightTick && pinned && inFlightKey !== key) {
    const after = () => tick(options);
    return inFlightTick.then(after, after);
  }
  if (inFlightTick) return inFlightTick;
  inFlightPinned = options.recordKey;
  inFlightKey = key;
  inFlightTick = runTick(options).finally(() => {
    inFlightTick = null;
    inFlightPinned = undefined;
    inFlightKey = null;
  });
  return inFlightTick;
}

/**
 * Poll once and wait for it. Exported so a caller that wants fresh counters
 * right now doesn't have to sit out the interval, and so a shell with no
 * interval (the browser worker) can drive every tick itself.
 */
export async function pollGalaxyNow(options: PollOptions = {}): Promise<TickResult> {
  // A tick already running was started without these asks: wait it out, then run one that has them.
  if (options.awaitEnrichment || options.reconcile || options.recover || options.recordKey) {
    while (inFlightTick) await inFlightTick;
  }
  return tickResult(await tick(options));
}

/** Resolves once no tick is running. */
export async function pollerIdle(): Promise<void> {
  while (inFlightTick) await inFlightTick;
}

async function tickResult(run: TickRun): Promise<TickResult> {
  const result: TickResult = {
    recordKey: run.recordKey,
    transitions: run.transitions,
    inProgress: 0,
    pendingEnrichment: 0,
    openSubmissions: 0,
  };
  const followUps = run.transitions.filter(followsUp).map(asFollowUp);
  if (followUps.length > 0) result.resumePrompt = buildResumePrompt(followUps);
  if (!run.recordKey) return result;
  // What can't be read counts as still open, so a caller waiting for quiet doesn't stop on a fault.
  try {
    const content = await readNotebook(run.recordKey);
    const blocks = [...findJobBlocks(content), ...findInvocationBlocks(content)];
    result.inProgress = blocks.filter((b) => b.status === "in_progress").length;
    // What galaxy-enrich would still try: ended, not yet enriched, and on this server.
    const server = getGalaxyConfig()?.url;
    result.pendingEnrichment = server
      ? blocks.filter(
          (b) =>
            b.status !== "in_progress" &&
            b.enrichment === "pending" &&
            sameGalaxyServer(b.galaxyServerUrl, server),
        ).length
      : 0;
  } catch (err) {
    // A record that's gone took its blocks with it; only a present one we couldn't read stays open.
    if (await statNotebook(run.recordKey).catch(() => true)) {
      console.error("[galaxy-poller] record not read for the tick result:", err);
      result.inProgress = 1;
    }
  }
  try {
    const open = await submissionLedger().open(run.recordKey);
    result.openSubmissions = open.filter((e) => !isClosedSubmission(e)).length;
  } catch (err) {
    console.error("[galaxy-poller] open submissions not read:", err);
    result.openSubmissions = 1;
  }
  return result;
}

async function runTick(options: PollOptions): Promise<TickRun> {
  // Everything this tick writes goes by this key, so a tick that outlives a
  // session switch still lands in its own record.
  const tickNotebook = options.recordKey ?? getNotebookPath();
  const tickGeneration = generation;
  // Still this tick's to report if no session started since, or the one that did is on the same
  // record: a replacement on the same notebook would never see these blocks in flight again. A
  // pinned record is this tick's to report only while it's the bound one.
  const current = () =>
    options.recordKey !== undefined
      ? getNotebookPath() === tickNotebook
      : tickGeneration === generation ||
        (tickNotebook !== null && getNotebookPath() === tickNotebook);
  // Returned by reference, so the early returns below still carry what the finally delivers.
  const run: TickRun = { recordKey: tickNotebook, transitions: [] };
  try {
    if (options.recover && tickNotebook) {
      try {
        await recoverSubmissions(tickNotebook);
      } catch (err) {
        console.error("[galaxy-poller] submission recovery failed:", err);
      }
    }
    // One read per tick, shared by everything below: what the notebook says is
    // in flight is the whole of the poller's worklist.
    const content = await readNotebookOrNull(tickNotebook);
    // Before the early returns below: a hook that only ran when the notebook
    // had in-flight blocks would be a hook that stops the moment the analysis
    // goes quiet, which is exactly when a panel still has to say something.
    //
    // Deliberately not awaited. A hook is an extra, and this tick's real work
    // -- advancing in-flight invocations and jobs -- must not wait behind one
    // that is talking to a Galaxy that has stopped answering. The hook is
    // responsible for its own re-entrancy; both failure paths are swallowed
    // here so a rejection cannot surface as an unhandled one. A panel shows the bound record,
    // so an unshown one's pinned tick doesn't feed it.
    if (tickHook && (options.recordKey === undefined || current())) {
      try {
        void tickHook(content).catch((err) => {
          console.error("[galaxy-poller] tick hook failed:", err);
        });
      } catch (err) {
        console.error("[galaxy-poller] tick hook threw:", err);
      }
    }
    if (content === null) {
      // The notebook itself is gone, so every block we were watching went with
      // it -- same silencing, one level up. An unreadable-but-present notebook
      // is a transient we say nothing about; an absent one is not.
      if (tickNotebook && !(await statNotebook(tickNotebook)) && current()) {
        await reportMissingBlocks(tickNotebook, "", current);
      }
      return run;
    }
    if (tickNotebook) await settleLeftovers(tickNotebook, content);
    if (current()) {
      trackActiveBlocks(content);
      if (tickNotebook) await reportMissingBlocks(tickNotebook, content, current);
    }

    // Tool runs are tracked separately from workflow invocations and are the
    // only thing advancing in a session that never invoked a workflow (#413).
    if (tickNotebook) await tickJobs(tickNotebook, content, current);

    // Cheap path when nothing's in-flight: scan and return.
    if (!tickNotebook || !hasInProgressInvocations(content)) {
      return run;
    }
    if (!getGalaxyConfig()) {
      // Credentials disappeared (user disconnected mid-session). Skip
      // this tick; if creds come back the next tick picks up.
      return run;
    }
    const result = await checkInvocations(
      undefined,
      undefined,
      invocationHooks(tickNotebook),
      tickNotebook,
    );
    // Fire a completion toast for any invocation that JUST reached a terminal
    // state this tick. The poller only checks blocks that were in_progress, so
    // an autoAction of completed/failed is a fresh transition that won't recur
    // (the block is terminal next tick and no longer checked) — notify once.
    const results = (result.details as { results?: PollResultEntry[] } | undefined)?.results;
    // Not gated on `notify`: a headless shell has no toast to show but must
    // still hand the finished run back to the agent when auto-resume is on.
    if (Array.isArray(results)) {
      const willResume = followUpsOn();
      for (const r of results) {
        const label = r.label || r.notebookAnchor || r.invocationId;
        // A row for what the block's status actually became, and only when it
        // became something else: `autoAction` survives the check's own blanking
        // only for a transition that landed on disk, and a mid-flight failure
        // deliberately leaves the status where it was.
        if (r.autoAction && r.newStatus && r.newStatus !== r.priorStatus) {
          logTransition(tickNotebook, {
            blockKind: "invocation",
            id: r.invocationId,
            label,
            notebookAnchor: r.notebookAnchor ?? null,
            from: r.priorStatus ?? "in_progress",
            to: r.newStatus,
            outcome: r.autoAction,
            counters: { ...(r.jobSummary ?? {}), active: r.activeJobs ?? 0 },
            lastPolledAt: r.lastPolledAt ?? null,
          });
        }
        if (!current()) continue;
        if (r.autoAction === "completed") {
          notifySafely(
            `✅ Galaxy: "${label}" finished (${r.jobSummary?.ok ?? 0} jobs ok)${willResume ? " — outputs require verification." : " — automatic follow-up disabled."}`,
            "info",
          );
        } else if (r.autoAction === "failed") {
          notifySafely(
            `❌ Galaxy: "${label}" failed (${r.jobSummary?.error ?? 0} job error(s))${willResume ? " — failure recorded." : " — automatic follow-up disabled."}`,
            "warning",
          );
        } else if (r.autoAction === "cancelled") {
          notifySafely(
            `⏹️ Galaxy: "${label}" was cancelled — ${r.jobSummary?.ok ?? 0} job(s) finished before it stopped.`,
            "info",
          );
        } else if (r.autoAction === "failing" && !announcedFailing.has(r.invocationId)) {
          announcedFailing.add(r.invocationId);
          notifySafely(
            `⚠️ Galaxy: "${label}" — ${r.jobSummary?.error ?? 0} job(s) failed, ${r.activeJobs ?? 0} still running${willResume ? " — failure recorded." : " — automatic follow-up disabled."}`,
            "warning",
          );
        }
      }
    }
  } catch (err) {
    // Don't kill the timer on a single bad poll — Galaxy may be
    // briefly unreachable. Log and try again on the next tick.
    console.error("[galaxy-poller] tick failed:", err);
  } finally {
    // Batch jobs and workflows into one turn, even if a later poll request
    // failed. Queuing each finished import separately floods the agent.
    //
    // What to deliver is what the ledger holds confirmed for this tick's
    // record, so a transition a dead tick persisted but never announced goes
    // out with this one. A tick whose session switched to another record
    // leaves them there for the next tick on this one.
    if (tickNotebook && current()) run.transitions = await deliverEvents(tickNotebook);
    // The count paces the bound record's reconcile; an unshown record's tick runs no capture hook.
    if (options.recordKey === undefined || current()) tickCount++;
    // Reconcile and enrichment read whichever record is bound when they run, so a tick whose
    // session moved to another record leaves them to that session's own ticks.
    if (captureHook && current()) {
      const wait = !!(options.awaitEnrichment || options.reconcile);
      try {
        const hook = captureHook(tickCount, { reconcile: !!options.reconcile, wait });
        if (wait) await hook;
        else {
          void hook.catch((err) => {
            console.error("[galaxy-poller] capture hook failed:", err);
          });
        }
      } catch (err) {
        console.error("[galaxy-poller] capture hook threw:", err);
      }
    }
  }
  return run;
}

/**
 * Hand the record's undelivered events to the follow-up, and mark them delivered whether or not
 * anyone took them: the desktop has always dropped a follow-up nobody could receive. (A tick whose
 * session moved to another record doesn't get here; its events wait for that record's next tick,
 * so reopening it later delivers them then.) Under the
 * worker the durable watch delivers them and marks them itself, so they are only returned.
 */
async function deliverEvents(tickNotebook: string): Promise<TerminalEvent[]> {
  const ledger = submissionLedger();
  let events: TerminalEvent[];
  try {
    events = await ledger.undelivered(tickNotebook);
  } catch (err) {
    console.error("[galaxy-poller] undelivered events not read:", err);
    return [];
  }
  if (events.length === 0 || underWorker()) return events;
  const followUps = events.filter(followsUp).map(asFollowUp);
  const deliver = resume;
  if (deliver && followUps.length > 0 && getNotebookPath() === tickNotebook) {
    try {
      deliver(buildResumePrompt(followUps));
    } catch (err) {
      console.error("[galaxy-poller] auto-resume send failed:", err);
    }
  }
  try {
    await ledger.delivered(
      tickNotebook,
      events.map((e) => e.key),
    );
  } catch (err) {
    console.error("[galaxy-poller] events not marked delivered:", err);
  }
  return events;
}

export function startGalaxyPoller(notifyFn?: PollerNotify, resumeFn?: PollerResume): void {
  stopGalaxyPoller();
  generation++;
  // Capture the shell notifier (from the session_start ctx) so a completed
  // background invocation can toast the user. Refreshed each session_start.
  notify = notifyFn ?? null;
  // Null when auto-resume is disabled; the caller decides, so the poller
  // stays free of config lookups on a 15s timer. Under the worker the durable
  // watch is the one deliverer, since a follow-up queued here dies with a reload.
  resume = underWorker() ? null : (resumeFn ?? null);
  announcedFailing.clear();
  trackedActive.clear();
  // The watch is the worker's only clock: no interval, and no tick until it asks.
  if (underWorker()) return;
  // Idempotent: a brain restart triggers a new session_start without
  // session_shutdown firing first in some failure modes. Stop any
  // pre-existing timer so we don't double-poll.
  // Fire one immediate tick so a session resumed with in-flight blocks
  // gets fresh counters within the first second instead of waiting 15s.
  void tick();
  const interval = setInterval(tick, POLL_INTERVAL_MS);
  // A background refresher must never be the reason the process stays alive.
  // In print/rpc modes (`--mode json`, evals) the work finishes and nothing
  // else holds the loop, so an armed interval kept the process up until
  // something killed it; session_shutdown clears the timer, but relying on
  // shutdown running is what made that a 15s-per-run tax when it didn't.
  // Interactive and Orbit sessions are held open by stdin, so unref costs
  // them nothing.
  interval.unref?.();
  timer = interval;
}

export function stopGalaxyPoller(): void {
  resume = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
