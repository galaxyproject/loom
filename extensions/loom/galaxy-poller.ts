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

import { getNotebookPath } from "./state.js";
import {
  findInvocationBlocks,
  readNotebook,
  withNotebookLock,
  writeNotebook,
} from "./notebook-writer.js";
import { checkInvocations } from "./tools.js";
import { getGalaxyConfig, galaxyGetJobDetails } from "./galaxy-api.js";
import { buildResumePrompt } from "./auto-resume.js";
import {
  applyJobPollUpdate,
  findJobBlocks,
  isTerminalJobState,
  jobStatusFromGalaxyState,
} from "./galaxy-job-block.js";

// 15s — ~4 polls/min × a few in-flight invocations stays well under
// usegalaxy.org's per-user rate budget while still feeling live.
const POLL_INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** Surface a toast to the shell when a background invocation finishes. */
type PollerNotify = (text: string, level: "info" | "warning" | "error") => void;
let notify: PollerNotify | null = null;

/**
 * Hand a finished run back to the agent as a queued follow-up, so it verifies
 * outputs itself instead of the toast asking the user to relay. Null when
 * auto-resume is off, which is the default.
 *
 * Must queue rather than interrupt: delivering a prompt to a brain that is
 * mid-turn fails outright with "Agent is already processing".
 */
type PollerResume = (text: string) => void;
let resume: PollerResume | null = null;

/** Subset of a checkInvocations result entry the poller needs for notifications. */
interface PollResultEntry {
  invocationId: string;
  notebookAnchor?: string;
  label?: string;
  jobSummary?: { ok?: number; error?: number };
  autoAction?: string;
}

async function hasInProgressInvocations(): Promise<boolean> {
  const nbPath = getNotebookPath();
  if (!nbPath) return false;
  try {
    const content = await readNotebook(nbPath);
    return findInvocationBlocks(content).some((b) => b.status === "in_progress");
  } catch {
    // Notebook missing or unreadable — no invocations to poll.
    return false;
  }
}

/**
 * Advance in-flight `loom-job` blocks -- single Galaxy tool runs, which have no
 * invocation to poll. One GET per in-flight job, and only for jobs that are
 * still running, so an idle notebook costs nothing beyond the scan the
 * invocation path already does.
 */
async function tickJobs(): Promise<void> {
  const nbPath = getNotebookPath();
  if (!nbPath) return;

  let pending: ReturnType<typeof findJobBlocks>;
  try {
    pending = findJobBlocks(await readNotebook(nbPath)).filter((j) => j.status === "in_progress");
  } catch {
    return; // notebook missing or unreadable -- nothing to advance
  }
  if (pending.length === 0) return;
  if (!getGalaxyConfig()) return;

  for (const job of pending) {
    let state: string | undefined;
    try {
      state = (await galaxyGetJobDetails(job.jobId)).state;
    } catch (err) {
      // One unreachable job must not stop the others, or kill the timer.
      console.error(`[galaxy-poller] job ${job.jobId} poll failed:`, err);
      continue;
    }
    if (!isTerminalJobState(state)) continue;

    // Terminal by the check above, so the in_progress arm of the union is
    // unreachable here — narrow it rather than casting at each use.
    const mapped = jobStatusFromGalaxyState(state);
    if (mapped === "in_progress") continue;
    const status: "completed" | "failed" = mapped;
    // Re-read inside the lock: the agent may have edited the notebook during
    // the Galaxy round trip, and applyJobPollUpdate touches only poll-owned
    // fields so a concurrent label/anchor edit survives.
    await withNotebookLock(nbPath, async () => {
      const content = await readNotebook(nbPath);
      const updated = applyJobPollUpdate(content, {
        jobId: job.jobId,
        status,
        galaxyState: state,
        lastPolledAt: new Date().toISOString(),
      });
      if (updated !== content) await writeNotebook(nbPath, updated);
    });

    const label = job.label || job.toolId || job.jobId;
    // With auto-resume on, the agent picks the work up itself, so the toast
    // stops telling the user to do the relaying.
    const willResume = resume !== null;
    if (notify) {
      notify(
        status === "completed"
          ? `✅ Galaxy: "${label}" finished${willResume ? " — verifying outputs…" : " — ask me to verify the outputs."}`
          : `❌ Galaxy: "${label}" failed (${state})${willResume ? " — investigating…" : " — ask me to investigate."}`,
        status === "completed" ? "info" : "warning",
      );
    }
    resume?.(buildResumePrompt(label, status, status === "failed" ? state : undefined));
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Tool runs are tracked separately from workflow invocations and are the
    // only thing advancing in a session that never invoked a workflow (#413).
    await tickJobs();

    // Cheap path when nothing's in-flight: read notebook, scan, return.
    if (!(await hasInProgressInvocations())) return;
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
        if (r.autoAction === "completed") {
          notify?.(
            `✅ Galaxy: "${label}" finished (${r.jobSummary?.ok ?? 0} jobs ok)${willResume ? " — verifying outputs…" : " — ask me to verify the outputs."}`,
            "info",
          );
          resume?.(buildResumePrompt(label, "completed"));
        } else if (r.autoAction === "failed") {
          notify?.(
            `❌ Galaxy: "${label}" failed (${r.jobSummary?.error ?? 0} job error(s))${willResume ? " — investigating…" : " — ask me to investigate."}`,
            "warning",
          );
          resume?.(buildResumePrompt(label, "failed", `${r.jobSummary?.error ?? 0} job error(s)`));
        }
      }
    }
  } catch (err) {
    // Don't kill the timer on a single bad poll — Galaxy may be
    // briefly unreachable. Log and try again on the next tick.
    console.error("[galaxy-poller] tick failed:", err);
  } finally {
    inFlight = false;
  }
}

export function startGalaxyPoller(notifyFn?: PollerNotify, resumeFn?: PollerResume): void {
  // Capture the shell notifier (from the session_start ctx) so a completed
  // background invocation can toast the user. Refreshed each session_start.
  notify = notifyFn ?? null;
  // Null unless auto-resume is opted in; the caller decides, so the poller
  // stays free of config lookups on a 15s timer.
  resume = resumeFn ?? null;
  // Idempotent: a brain restart triggers a new session_start without
  // session_shutdown firing first in some failure modes. Stop any
  // pre-existing timer so we don't double-poll.
  stopGalaxyPoller();
  // Fire one immediate tick so a session resumed with in-flight blocks
  // gets fresh counters within the first second instead of waiting 15s.
  void tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopGalaxyPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
