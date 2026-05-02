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
import { findInvocationBlocks, readNotebook } from "./notebook-writer.js";
import { checkInvocations } from "./tools.js";
import { getGalaxyConfig } from "./galaxy-api.js";

// 15s — ~4 polls/min × a few in-flight invocations stays well under
// usegalaxy.org's per-user rate budget while still feeling live.
const POLL_INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

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

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Cheap path when nothing's in-flight: read notebook, scan, return.
    if (!(await hasInProgressInvocations())) return;
    if (!getGalaxyConfig()) {
      // Credentials disappeared (user disconnected mid-session). Skip
      // this tick; if creds come back the next tick picks up.
      return;
    }
    await checkInvocations(undefined);
  } catch (err) {
    // Don't kill the timer on a single bad poll — Galaxy may be
    // briefly unreachable. Log and try again on the next tick.
    console.error("[galaxy-poller] tick failed:", err);
  } finally {
    inFlight = false;
  }
}

export function startGalaxyPoller(): void {
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
