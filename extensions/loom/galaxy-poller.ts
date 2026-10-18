import { isSupersededAttempt } from "./registry-runtime.js";
import {
  currentGalaxyConnection,
  listGalaxyConnections,
  verifyGalaxyAccount,
  withGalaxyConnection,
  matchesGalaxyOrigin,
  type GalaxyOrigin,
} from "./galaxy-connections.js";
import { onRecordedGalaxy } from "./galaxy-api.js";
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
import { checkInvocations, isInvocationLive } from "./tools.js";
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
let inFlightTick: Promise<void> | null = null;

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
 */
type CaptureTickHook = (tickNumber: number) => Promise<void>;
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
function logTransition(payload: Record<string, unknown>): void {
  const nbPath = getNotebookPath();
  if (!nbPath) return;
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
interface TrackedBlock extends GalaxyOrigin {
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
 * Galaxy run out of Loom's sight with nothing said. We can't put the block back
 * (it is the user's file, and re-inserting it would fight whoever removed it),
 * but we can refuse to let it go quietly. Reset per session in
 * startGalaxyPoller.
 */
const trackedActive = new Map<string, TrackedBlock>();

function trackKey(kind: TrackedBlock["kind"], id: string, origin: GalaxyOrigin): string {
  return `${origin.galaxyServerUrl}:${origin.connectionId ?? ""}:${origin.accountId ?? ""}:${kind}:${id}`;
}

/**
 * Remember the blocks that are in flight right now, and forget the ones that
 * have reached a terminal status. What survives is exactly the set whose
 * disappearance would cost us a running job.
 */
function trackActiveBlocks(content: string): void {
  for (const inv of findInvocationBlocks(content)) {
    const key = trackKey("invocation", inv.invocationId, inv);
    if (inv.status === "in_progress") {
      trackedActive.set(key, {
        galaxyServerUrl: inv.galaxyServerUrl,
        connectionId: inv.connectionId,
        accountId: inv.accountId,
        kind: "invocation",
        id: inv.invocationId,
        label: inv.label || inv.notebookAnchor || inv.invocationId,
      });
    } else {
      trackedActive.delete(key);
    }
  }
  for (const job of findJobBlocks(content)) {
    const key = trackKey("job", job.jobId, job);
    if (job.status === "in_progress") {
      trackedActive.set(key, {
        galaxyServerUrl: job.galaxyServerUrl,
        connectionId: job.connectionId,
        accountId: job.accountId,
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
function announceMissingBlock(block: TrackedBlock, state: string | undefined): void {
  const nbPath = getNotebookPath();
  if (nbPath) {
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
  }
  if (notify) {
    notify(
      `⚠️ Galaxy: "${block.label}" is still ${state ?? "running"} on Galaxy, but its ${block.kind} block is gone from the notebook — Loom has stopped tracking it.`,
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
async function reportMissingBlocks(content: string): Promise<void> {
  if (trackedActive.size === 0) return;
  const present = new Set<string>();
  for (const inv of findInvocationBlocks(content)) {
    present.add(trackKey("invocation", inv.invocationId, inv));
  }
  for (const job of findJobBlocks(content)) present.add(trackKey("job", job.jobId, job));

  const missing = [...trackedActive.entries()].filter(
    ([key, block]) =>
      !present.has(key) && (!currentGalaxyConnection() || matchesGalaxyOrigin(block)),
  );
  if (missing.length === 0) return;
  // No credentials, no verdict: keep the ids and ask again next tick.
  if (!getGalaxyConfig()) return;

  for (const [key, block] of missing) {
    let result: { live: boolean; state?: string };
    try {
      result = await onRecordedGalaxy(block, () => isStillLive(block), getGalaxyConfig()?.url);
    } catch (err) {
      // Galaxy briefly unreachable. Stay tracked and ask again next tick; one
      // unreachable id must not cost the others their check. A few attempts in,
      // stop asking -- the answer isn't coming.
      console.error(`[galaxy-poller] ${block.kind} ${block.id} liveness check failed:`, err);
      const failures = (block.checkFailures ?? 0) + 1;
      if (failures >= MAX_MISSING_CHECK_ATTEMPTS) trackedActive.delete(key);
      else trackedActive.set(key, { ...block, checkFailures: failures });
      continue;
    }
    // One verdict per id, either way: the block is gone, so there is nothing
    // left to re-examine. Recording it again re-arms the tracking.
    trackedActive.delete(key);
    if (result.live) announceMissingBlock(block, result.state);
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
 * orders Loom's own writers, and the agent edits notebook.md directly.
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
    const priorStatus = findJobBlocks(fresh).find(
      (j) =>
        j.jobId === update.jobId &&
        matchesGalaxyOrigin(
          j,
          update.galaxyServerUrl
            ? { ...update, galaxyServerUrl: update.galaxyServerUrl }
            : undefined,
        ),
    )?.status;
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
async function readNotebookOrNull(): Promise<string | null> {
  const nbPath = getNotebookPath();
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
async function tickJobs(content: string, followUps: GalaxyFollowUp[]): Promise<void> {
  const nbPath = getNotebookPath();
  if (!nbPath) return;

  const pending = findJobBlocks(content).filter(
    (j) => j.status === "in_progress" && (!currentGalaxyConnection() || matchesGalaxyOrigin(j)),
  );
  if (pending.length === 0) return;
  const currentServer = getGalaxyConfig()?.url;
  if (!currentServer) return;

  for (const job of pending) {
    let state: string | undefined;
    try {
      state = (
        await onRecordedGalaxy(job, () => galaxyGetJobDetails(job.jobId), getGalaxyConfig()?.url)
      ).state;
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
      if (
        job.galaxyState !== state ||
        !job.lastPolledAt ||
        Date.now() - Date.parse(job.lastPolledAt) > 60_000 ||
        job.serverVerified === false
      ) {
        try {
          await withNotebookLock(nbPath, () =>
            // Only the flag and the timestamp: this write knows nothing about
            // the outcome, and the snapshot's status is already older than
            // whatever the fresh read inside persistJobUpdate will see.
            persistJobUpdate(nbPath, {
              galaxyServerUrl: job.galaxyServerUrl,
              connectionId: job.connectionId,
              accountId: job.accountId,
              jobId: job.jobId,
              galaxyState: state,
              lastPolledAt: new Date().toISOString(),
              serverVerified: sameGalaxyServer(job.galaxyServerUrl, currentServer),
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
    let persisted: { written: boolean; priorStatus?: JobYaml["status"] };
    try {
      persisted = await withNotebookLock(nbPath, () =>
        persistJobUpdate(nbPath, {
          galaxyServerUrl: job.galaxyServerUrl,
          connectionId: job.connectionId,
          accountId: job.accountId,
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
      console.error(`[galaxy-poller] job ${job.jobId} update failed:`, err);
      continue;
    }
    // The block was deleted mid-poll, or another writer already advanced it.
    // Either way this tick didn't transition anything, so there's no news.
    if (!persisted.written) continue;
    if (persisted.priorStatus === status) continue;

    const label = job.label || job.toolId || job.jobId;
    logTransition({
      blockKind: "job",
      id: job.jobId,
      label,
      toolId: job.toolId ?? null,
      from: persisted.priorStatus ?? job.status,
      to: status,
      galaxyState: state ?? null,
      lastPolledAt: polledAt,
    });
    const willResume = resume !== null && isResumableOutcome(status);
    notifySafely(...jobFinishedToast(status, label, state, willResume));
    if (isResumableOutcome(status) && !isSupersededAttempt(job.attemptId)) {
      followUps.push({
        kind: "job",
        id: job.jobId,
        label,
        notebookAnchor: job.notebookAnchor,
        outcome: status,
        detail: state,
      });
    }
  }
}

/** Run a poll tick now, or hand back the one already running. */
function tick(): Promise<void> {
  if (inFlightTick) return inFlightTick;
  inFlightTick = runTick().finally(() => {
    inFlightTick = null;
  });
  return inFlightTick;
}

/**
 * Poll once and wait for it. Exported so a caller that wants fresh counters
 * right now doesn't have to sit out the interval.
 */
export function pollGalaxyNow(): Promise<void> {
  return tick();
}

async function runTick(): Promise<void> {
  const connections = listGalaxyConnections();
  if (connections.length < 2) return runConnectionTick();
  await Promise.all(
    connections.map(async (connection) => {
      try {
        await withGalaxyConnection(await verifyGalaxyAccount(connection), runConnectionTick);
      } catch (error) {
        console.error(`[galaxy-poller] ${connection.name}:`, (error as Error).message);
      }
    }),
  );
}

async function runConnectionTick(): Promise<void> {
  const tickNotebook = getNotebookPath();
  const followUps: GalaxyFollowUp[] = [];
  try {
    // One read per tick, shared by everything below: what the notebook says is
    // in flight is the whole of the poller's worklist.
    const content = await readNotebookOrNull();
    // Before the early returns below: a hook that only ran when the notebook
    // had in-flight blocks would be a hook that stops the moment the analysis
    // goes quiet, which is exactly when a panel still has to say something.
    //
    // Deliberately not awaited. A hook is an extra, and this tick's real work
    // -- advancing in-flight invocations and jobs -- must not wait behind one
    // that is talking to a Galaxy that has stopped answering. The hook is
    // responsible for its own re-entrancy; both failure paths are swallowed
    // here so a rejection cannot surface as an unhandled one.
    if (
      tickHook &&
      (!currentGalaxyConnection() || currentGalaxyConnection()?.mcpServer === "galaxy")
    ) {
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
      const nbPath = getNotebookPath();
      if (nbPath && !(await statNotebook(nbPath))) await reportMissingBlocks("");
      return;
    }
    trackActiveBlocks(content);
    await reportMissingBlocks(content);

    // Tool runs are tracked separately from workflow invocations and are the
    // only thing advancing in a session that never invoked a workflow (#413).
    await tickJobs(content, followUps);

    // Cheap path when nothing's in-flight: scan and return.
    if (!hasInProgressInvocations(content)) return;
    if (!getGalaxyConfig()) {
      // Credentials disappeared (user disconnected mid-session). Skip
      // this tick; if creds come back the next tick picks up.
      return;
    }
    const result = await checkInvocations(undefined);
    // Fire a completion toast for any invocation that JUST reached a terminal
    // state this tick. The poller only checks blocks that were in_progress, so
    // an autoAction of completed/failed is a fresh transition that won't recur
    // (the block is terminal next tick and no longer checked) — notify once.
    const results = (result.details as { results?: PollResultEntry[] } | undefined)?.results;
    // Not gated on `notify`: a headless shell has no toast to show but must
    // still hand the finished run back to the agent when auto-resume is on.
    if (Array.isArray(results)) {
      const willResume = resume !== null;
      for (const r of results) {
        const label = r.label || r.notebookAnchor || r.invocationId;
        // A row for what the block's status actually became, and only when it
        // became something else: `autoAction` survives the check's own blanking
        // only for a transition that landed on disk, and a mid-flight failure
        // deliberately leaves the status where it was.
        if (r.autoAction && r.newStatus && r.newStatus !== r.priorStatus) {
          logTransition({
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
        if (r.autoAction === "completed") {
          notifySafely(
            `✅ Galaxy: "${label}" finished (${r.jobSummary?.ok ?? 0} jobs ok)${willResume ? " — outputs require verification." : " — automatic follow-up disabled."}`,
            "info",
          );
          followUps.push({
            kind: "invocation",
            id: r.invocationId,
            label,
            notebookAnchor: r.notebookAnchor,
            outcome: "completed",
          });
        } else if (r.autoAction === "failed") {
          notifySafely(
            `❌ Galaxy: "${label}" failed (${r.jobSummary?.error ?? 0} job error(s))${willResume ? " — failure recorded." : " — automatic follow-up disabled."}`,
            "warning",
          );
          followUps.push({
            kind: "invocation",
            id: r.invocationId,
            label,
            notebookAnchor: r.notebookAnchor,
            outcome: "failed",
            detail: `${r.jobSummary?.error ?? 0} job error(s)`,
          });
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
          followUps.push({
            kind: "invocation",
            id: r.invocationId,
            label,
            notebookAnchor: r.notebookAnchor,
            outcome: "failing",
            detail: `${r.jobSummary?.error ?? 0} job(s) failed, ${r.activeJobs ?? 0} still running`,
          });
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
    // Deliver through whoever owns the poller now, not whoever started this
    // tick: the transitions are already persisted, so a replacement session
    // on the same notebook would never see them in_progress again. A stopped
    // poller has no resume, and a different notebook's session isn't ours.
    const deliver = resume;
    if (deliver && followUps.length > 0 && getNotebookPath() === tickNotebook) {
      try {
        const live = await readNotebookOrNull();
        const selected = followUps.filter((run) => {
          const block =
            run.kind === "job"
              ? findJobBlocks(live ?? "").find((b) => b.jobId === run.id && matchesGalaxyOrigin(b))
              : findInvocationBlocks(live ?? "").find(
                  (b) => b.invocationId === run.id && matchesGalaxyOrigin(b),
                );
          return !isSupersededAttempt(block?.attemptId);
        });
        const connection = currentGalaxyConnection();
        if (selected.length)
          deliver(
            buildResumePrompt(
              selected.map((run) => ({
                ...run,
                ...(connection ? { serverUrl: connection.url, connectionId: connection.id } : {}),
              })),
            ),
          );
      } catch (err) {
        console.error("[galaxy-poller] auto-resume send failed:", err);
      }
    }
    tickCount++;
    if (captureHook) {
      try {
        void captureHook(tickCount).catch((err) => {
          console.error("[galaxy-poller] capture hook failed:", err);
        });
      } catch (err) {
        console.error("[galaxy-poller] capture hook threw:", err);
      }
    }
  }
}

export function startGalaxyPoller(notifyFn?: PollerNotify, resumeFn?: PollerResume): void {
  stopGalaxyPoller();
  // Capture the shell notifier (from the session_start ctx) so a completed
  // background invocation can toast the user. Refreshed each session_start.
  notify = notifyFn ?? null;
  // Null when auto-resume is disabled; the caller decides, so the poller
  // stays free of config lookups on a 15s timer.
  resume = resumeFn ?? null;
  announcedFailing.clear();
  trackedActive.clear();
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
