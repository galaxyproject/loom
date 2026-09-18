/**
 * Running jobs widget -- the panel that answers "is my analysis still running,
 * and is it going well?"
 *
 * Two kinds of run reach it through `ctx.sources.invocations`, both derived
 * from the notebook markdown: `loom-invocation` blocks (a workflow) and
 * `loom-job` blocks (a single tool run, and the only thing that moves in a
 * session that never invoked a workflow).
 *
 * Three rules shape everything below.
 *
 * A failure is never quiet. A run with a failed job sorts to the top, gets a
 * red row and a red strip at the top of the panel, and the strip names the plan
 * step when the notebook binds the run to one. The person reading this cannot
 * open a terminal; if they miss the failure here they miss it entirely.
 *
 * A number nobody refreshed is not a live number. `last_polled_at` is the only
 * evidence we have that Galaxy was asked recently, so every row says when that
 * was, and a run that has gone quiet says "can't tell" rather than drawing a
 * confident stale bar. That heartbeat is trustworthy for invocations and not
 * for jobs -- see `isStaleTracked`.
 *
 * Nothing here polls anything. The only timer repaints relative times already
 * on screen, because "checked 40 s ago" frozen at 40 s for an hour is the exact
 * lie the staleness line exists to prevent.
 */

import type { Invocation } from "../../galaxy-invocations.js";
import { safeName, safeNameOr } from "./text-safety.js";
import type {
  DashboardJob,
  InvocationSnapshot,
  PlanSection,
  WidgetDefinition,
  WidgetDispose,
} from "../widget-api.js";

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * A `type`, not an `interface`: an interface has no implicit index signature
 * and will not assign to the registry's `WidgetDefinition<Record<string, unknown>>`.
 */
export type JobsConfig = {
  /** `active` also keeps anything that failed -- a failure is never hidden. */
  show: "active" | "all";
  /** How many rows to draw before collapsing the rest into a count. */
  limit: number;
  /** One line per run: no progress bar, no sentence, no link. */
  compact: boolean;
};

export const JOBS_DEFAULT_CONFIG: JobsConfig = { show: "active", limit: 6, compact: false };

const LIMIT_MIN = 1;
const LIMIT_MAX = 40;

/** The document is hand-editable and model-written, so nothing in it is trusted. */
export function normalizeJobsConfig(raw: Partial<Record<keyof JobsConfig, unknown>>): JobsConfig {
  const limitRaw = typeof raw.limit === "number" ? Math.floor(raw.limit) : NaN;
  return {
    show: raw.show === "all" ? "all" : "active",
    limit: Number.isFinite(limitRaw)
      ? Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, limitRaw))
      : JOBS_DEFAULT_CONFIG.limit,
    compact: raw.compact === true,
  };
}

// ── The normalized row ───────────────────────────────────────────────────────

export type RunState =
  | "running"
  | "queued"
  | "stopping"
  | "paused"
  | "finished"
  | "failed"
  | "cancelled"
  | "skipped"
  | "unknown";

export interface RunRow {
  kind: "invocation" | "job";
  id: string;
  label: string;
  state: RunState;
  /** True while Galaxy could still move this run. */
  live: boolean;
  jobs: { done: number; failed: number; total: number };
  steps: { done: number; total: number } | null;
  serverUrl: string;
  serverHost: string;
  anchor: string;
  /** The plan step this run is bound to, when the plan names it. */
  step: { number: number; title: string } | null;
  /** Epoch ms, or null when the block's timestamp will not parse. */
  submittedAt: number | null;
  lastPolledAt: number | null;
  /** The brain's own one-line note from the block. */
  summary: string | null;
  /** Galaxy's raw job state at the last poll. Jobs only. */
  galaxyState: string | null;
  toolId: string | null;
  /** Galaxy never confirmed this id exists. */
  unconfirmed: boolean;
  /** Live, and nobody has heard from Galaxy in a while. */
  stale: boolean;
}

/**
 * How long a live run may go without a fresh `last_polled_at` before the panel
 * stops believing its own numbers. The poller ticks every 15s, so this is
 * twenty missed ticks: far outside a slow Galaxy round trip or a tick that
 * waited on the notebook lock, and squarely in "Galaxy is unreachable, the
 * credentials are gone, or nothing is running to do the asking". A tighter
 * threshold cried wolf in the browser inside two minutes of a healthy run.
 */
export const STALE_AFTER_MS = 300_000;

/**
 * Galaxy's job states, folded to what the panel draws. Mirrors
 * `JOB_STATE_OUTCOME` in `extensions/loom/galaxy-job-block.ts` and adds the
 * non-terminal states that table deliberately omits.
 *
 * `deleting` and `stop` are the two that cost the brain a bug and would cost
 * this panel another: they are Galaxy on its way to `deleted` and `stopped`,
 * not Galaxy having arrived. A run in either is still moving.
 */
const GALAXY_JOB_STATE: Readonly<Record<string, RunState>> = {
  ok: "finished",
  error: "failed",
  failed: "failed",
  deleted: "cancelled",
  stopped: "cancelled",
  skipped: "skipped",
  running: "running",
  new: "queued",
  queued: "queued",
  waiting: "queued",
  paused: "paused",
  deleting: "stopping",
  stop: "stopping",
  // Galaxy serialises STOPPING as `stop` on the wire; the long spelling is here
  // so a client that sends the enum name does not fall through to `unknown`.
  stopping: "stopping",
  upload: "running",
  setting_metadata: "running",
  resubmitted: "queued",
};

const LIVE_STATES: ReadonlySet<RunState> = new Set([
  "running",
  "queued",
  "stopping",
  "paused",
  "unknown",
]);

/**
 * What a `loom-job` block is actually doing. The block's own status wins when
 * it is terminal -- the brain decided that, and Galaxy's raw state is only kept
 * alongside for display. While it is `in_progress` the raw state is the finer
 * answer, and a state this build has never heard of reads as `unknown` rather
 * than being guessed into `running`: the brain's own table treats an
 * unrecognised state as "keep watching", and so does this.
 */
export function foldJobState(status: DashboardJob["status"], galaxyState: string | null): RunState {
  if (status === "completed") return "finished";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  if (status !== "in_progress") return "unknown";
  // No recorded state is the NORMAL shape of a live tool run, not an edge case:
  // galaxy_job_record writes neither galaxy_state nor last_polled_at, and
  // tickJobs only writes them on a terminal transition. Reading that as
  // "queued" told the user a two-hour job had not started yet, for two hours.
  if (!galaxyState) return "unknown";
  return GALAXY_JOB_STATE[galaxyState.toLowerCase()] ?? "unknown";
}

/**
 * The one thing on disk that separates a workflow the user stopped from one
 * that broke. `loom-invocation` has three statuses and no fourth for a cancel,
 * so checkInvocations writes `status: failed` for both and distinguishes them
 * only in the summary it writes alongside.
 *
 * Reading that summary couples this panel to a sentence in the brain, which is
 * not free. It is worth it because the alternative is the loudest surface in
 * the product raising a red alarm about something the user did on purpose, and
 * a surface that cries wolf is not a surface anyone reads. The coupling is
 * fail-soft: if the wording changes the row just goes back to saying Failed.
 * The real fix is a `cancelled` value on `InvocationYaml["status"]`.
 */
const CANCELLED_SUMMARY = /^\s*workflow cancell(?:ed|ing)\b/i;

export function foldInvocationState(
  status: Invocation["status"],
  summary: string | null = null,
): RunState {
  if (status === "completed") return "finished";
  if (status === "failed") return CANCELLED_SUMMARY.test(summary ?? "") ? "cancelled" : "failed";
  // A cancel is not instant. Galaxy moves the invocation to `cancelled` and
  // then deletes its jobs one at a time, and the block stays `in_progress`
  // until the last of them has gone -- so the only window in which the panel
  // could shout about a deliberate cancel is exactly the window where the
  // status has not settled yet. Heading for the exit is `stopping`, which is
  // live, quiet, and says what is happening.
  if (status === "in_progress") {
    return CANCELLED_SUMMARY.test(summary ?? "") ? "stopping" : "running";
  }
  return "unknown";
}

function parseTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How far ahead of this machine's clock a Galaxy timestamp may sit and still
 * be read as a real event. Two machines a minute apart is ordinary; a stamp
 * further out than that is a hand edit or a bad clock, and believing it is
 * worse than having no stamp at all -- `now - heardFrom` goes permanently
 * negative, so the run can never be called stale again and the panel keeps
 * drawing confident numbers nobody has refreshed.
 */
const FUTURE_SKEW_MS = 60_000;

function parseStamp(iso: string | undefined, now: number): number | null {
  const ms = parseTime(iso);
  if (ms === null) return null;
  return ms - now > FUTURE_SKEW_MS ? null : ms;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Is this run's `last_polled_at` a heartbeat we can reason about?
 *
 * For an invocation, yes: `checkInvocations` rewrites the block on every poll
 * whether or not anything changed, precisely so the renderer can draw live
 * counters. For a job, no: `tickJobs` polls every 15s but only writes on a
 * terminal transition or the one-off `server_verified` upgrade, so a job that
 * has been running happily for two hours still carries the timestamp of its
 * first poll. Calling that stale would put "can't tell right now" on a run we
 * are checking four times a minute, which is a worse lie than the one the
 * staleness rule exists to prevent.
 */
function isStaleTracked(kind: RunRow["kind"]): boolean {
  return kind === "invocation";
}

/** `plan-a-step-1` -> the step it addresses, when the plan still has one. */
export function findStep(plans: PlanSection[], anchor: string): RunRow["step"] {
  if (!anchor) return null;
  for (const plan of plans) {
    for (const step of plan.steps) {
      // Either spelling notebook-anchors.ts accepts: the explicit `{#...}`
      // marker a step carries, or the positional address derived for a step
      // that carries none.
      if (step.anchor === anchor || `${plan.id}-step-${step.number}` === anchor) {
        return { number: step.number, title: step.title };
      }
    }
  }
  return null;
}

function invocationRow(inv: Invocation, plans: PlanSection[], now: number): RunRow {
  const summary = inv.summary?.trim() || null;
  const state = foldInvocationState(inv.status, summary);
  const done = count(inv.completedJobs);
  const failed = count(inv.failedJobs);
  // A hand-edited block can claim 12 total and 14 done. Believe the parts.
  const total = Math.max(count(inv.totalJobs), done + failed);
  const stepsTotal = count(inv.totalSteps);
  const lastPolledAt = parseStamp(inv.lastPolledAt, now);
  const submittedAt = parseStamp(inv.submittedAt, now);
  const live = LIVE_STATES.has(state);
  const heardFrom = lastPolledAt ?? submittedAt;
  return {
    kind: "invocation",
    id: inv.invocationId,
    label: inv.label,
    state,
    live,
    jobs: { done, failed, total },
    steps:
      stepsTotal > 0
        ? { done: Math.min(count(inv.completedSteps), stepsTotal), total: stepsTotal }
        : null,
    serverUrl: inv.galaxyServerUrl,
    serverHost: hostOf(inv.galaxyServerUrl),
    anchor: inv.notebookAnchor,
    step: findStep(plans, inv.notebookAnchor),
    submittedAt,
    lastPolledAt,
    summary,
    galaxyState: null,
    toolId: null,
    unconfirmed: inv.serverVerified === false,
    stale:
      isStaleTracked("invocation") &&
      live &&
      (heardFrom === null || now - heardFrom > STALE_AFTER_MS),
  };
}

function jobRow(job: DashboardJob, plans: PlanSection[], now: number): RunRow {
  const galaxyState = job.galaxyState?.trim() || null;
  const state = foldJobState(job.status, galaxyState);
  const live = LIVE_STATES.has(state);
  const lastPolledAt = parseStamp(job.lastPolledAt, now);
  const submittedAt = parseStamp(job.submittedAt, now);
  const heardFrom = lastPolledAt ?? submittedAt;
  return {
    kind: "job",
    id: job.jobId,
    label: job.label,
    state,
    live,
    jobs: { done: state === "finished" ? 1 : 0, failed: state === "failed" ? 1 : 0, total: 1 },
    steps: null,
    serverUrl: job.galaxyServerUrl,
    serverHost: hostOf(job.galaxyServerUrl),
    anchor: job.notebookAnchor,
    step: findStep(plans, job.notebookAnchor),
    submittedAt,
    lastPolledAt,
    summary: job.summary?.trim() || null,
    galaxyState,
    toolId: job.toolId,
    unconfirmed: job.serverVerified === false,
    stale:
      isStaleTracked("job") && live && (heardFrom === null || now - heardFrom > STALE_AFTER_MS),
  };
}

/**
 * Does this row deserve the user's attention right now?
 *
 * A cancelled run never does, however its counters read. Cancelling a workflow
 * deletes its jobs, and rollUpInvocationJobs scores `deleted` alongside `error`
 * in the same failed_jobs counter -- so without this exception every deliberate
 * cancel arrives here dressed as a failure.
 *
 * `stopping` is the same run a few seconds earlier, and it is exempt for the
 * same reason: the deleted jobs are already in the failed counter while the
 * cancel is still settling. Nothing Galaxy does on its own puts a run in
 * `stopping` -- both routes into it, a cancelling invocation and a job in
 * `deleting` or `stop`, are somebody having asked for it to end.
 */
export function needsAttention(row: RunRow): boolean {
  if (row.state === "cancelled" || row.state === "skipped" || row.state === "stopping") {
    return false;
  }
  return row.state === "failed" || row.jobs.failed > 0;
}

function rank(row: RunRow): number {
  if (needsAttention(row)) return 0;
  if (row.state === "paused") return 1;
  if (row.live) return 2;
  return 3;
}

/**
 * Every tracked run, normalized and ordered: failures first, then anything
 * waiting on the user, then whatever is still moving, then the finished work.
 * Newest first inside each band, with the id as a tiebreak so the order is
 * stable across renders.
 */
export function toRunRows(
  snapshot: InvocationSnapshot,
  plans: PlanSection[],
  now: number,
): RunRow[] {
  const rows: RunRow[] = [
    ...snapshot.invocations.map((inv) => invocationRow(inv, plans, now)),
    ...snapshot.jobs.map((job) => jobRow(job, plans, now)),
  ];
  return rows.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const bySubmitted = (b.submittedAt ?? 0) - (a.submittedAt ?? 0);
    if (bySubmitted !== 0) return bySubmitted;
    return a.id.localeCompare(b.id);
  });
}

/** What `show: "active"` keeps. A failure is never filtered away. */
export function isActiveRun(row: RunRow): boolean {
  return row.live || needsAttention(row);
}

// ── Words ────────────────────────────────────────────────────────────────────

const STATE_WORD: Readonly<Record<RunState, string>> = {
  running: "Running",
  queued: "Waiting for Galaxy",
  stopping: "Stopping",
  paused: "Paused",
  finished: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  unknown: "In progress",
};

/**
 * A glyph and a word before a colour: printed in greyscale, or read by someone
 * who cannot separate red from green, every row still says what it is.
 */
const STATE_GLYPH: Readonly<Record<RunState, string>> = {
  running: "●",
  queued: "○",
  stopping: "◐",
  paused: "⏸",
  finished: "✓",
  failed: "✕",
  cancelled: "⊘",
  skipped: "⊘",
  unknown: "?",
};

export function stateWord(state: RunState): string {
  return STATE_WORD[state] ?? STATE_WORD.unknown;
}

export function stateGlyph(state: RunState): string {
  return STATE_GLYPH[state] ?? STATE_GLYPH.unknown;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "45 s", "8 m", "1 h 34 m", "6 d 2 h". Never a bare number. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < MINUTE) return `${Math.floor(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} m`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return `${hours} h ${String(minutes).padStart(2, "0")} m`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return `${days} d ${hours} h`;
}

/** "1 h 34 m ago", or "" when the timestamp is missing. */
export function formatAgo(at: number | null, now: number): string {
  if (at === null) return "";
  const delta = now - at;
  // A clock skew between the Galaxy server and this machine must not print
  // a negative age.
  if (delta < 0) return "just now";
  const text = formatDuration(delta);
  return text ? `${text} ago` : "";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "7 of 12 jobs done, none failed" -- the counts, in words, or "". */
export function countsSentence(row: RunRow): string {
  const { done, failed, total } = row.jobs;
  if (row.kind === "job" || total === 0) return "";
  return `${done} of ${total} jobs done, ${failed > 0 ? `${failed} failed` : "none failed"}`;
}

/**
 * The row's headline, in a scientist's words rather than Galaxy's. Staleness
 * beats everything: a run we have not heard about is not a run we can describe.
 */
export function describeRun(row: RunRow, now: number): string {
  if (row.stale) {
    // Only the poll stamp answers "when was Galaxy last asked". Falling back to
    // the submit time here told a six-day-old invocation nobody has ever polled
    // that Galaxy was checked six days ago, one line above the meta line saying
    // "not checked yet".
    const ago = formatAgo(row.lastPolledAt, now);
    return ago
      ? `Can't tell right now. Galaxy was last checked ${ago}.`
      : "Can't tell right now. Galaxy has not been checked.";
  }

  const counts = countsSentence(row);
  const remaining = Math.max(0, row.jobs.total - row.jobs.done - row.jobs.failed);

  switch (row.state) {
    case "failed":
      if (row.kind === "job") return "Failed. Ask the agent what Galaxy reported.";
      if (row.jobs.failed > 0 && row.jobs.total > 1) {
        return `Failed -- ${row.jobs.failed} of ${row.jobs.total} jobs errored, ${row.jobs.done} succeeded.`;
      }
      if (row.jobs.failed > 0) return "Failed -- its job errored.";
      // Galaxy can fail an invocation without any job failing, by refusing to
      // schedule it. "0 of 12 jobs errored" would be nonsense there.
      return "Failed. No job errored on its own, so Galaxy stopped the workflow.";
    case "running":
      if (row.jobs.failed > 0) {
        return `${plural(row.jobs.failed, "job has", "jobs have")} failed. ${row.jobs.done} finished, ${remaining} still going.`;
      }
      if (counts) return `Running -- ${counts}.`;
      // A single tool run has no job counts and never will; saying Galaxy has
      // not reported them implies something is missing that is not.
      if (row.kind === "job") return "Running on Galaxy.";
      return "Running. Galaxy has not reported any job counts yet.";
    case "queued":
      return "Waiting for Galaxy to start it.";
    case "stopping":
      return "Stopping. Galaxy is still shutting this down.";
    case "paused":
      return "Paused -- it needs you before it can carry on.";
    case "finished":
      if (row.jobs.failed > 0) {
        return `Finished, but ${row.jobs.failed} of ${row.jobs.total} jobs failed.`;
      }
      if (row.jobs.total > 1) return `Finished -- all ${row.jobs.total} jobs succeeded.`;
      return "Finished.";
    case "cancelled":
      return "Cancelled. It produced no outputs.";
    case "skipped":
      return "Skipped. Its step's condition was not met.";
    default:
      if (row.kind === "job" && row.galaxyState === null) {
        return "Still going on Galaxy. Nothing more has been written down about it yet.";
      }
      return "Still going. Galaxy reported a state this version does not recognise.";
  }
}

/** The red strip at the top of the panel, or "" when nothing failed. */
export function attentionMessage(rows: RunRow[]): string {
  const bad = rows.filter(needsAttention);
  if (bad.length === 0) return "";
  if (bad.length === 1) {
    const row = bad[0];
    const name = safeNameOr(row.label || row.id, "(unnamed run)");
    // A run is usually labelled after the step it runs, so naming the step's
    // title as well costs a line of a 400px panel to say the same word twice.
    const stepTitle = row.step ? safeName(row.step.title) : "";
    const where = row.step
      ? name.toLowerCase().includes(stepTitle.toLowerCase())
        ? ` (step ${row.step.number})`
        : ` (step ${row.step.number}, ${stepTitle})`
      : "";
    if (row.jobs.total > 1 && row.jobs.failed > 0) {
      return `${row.jobs.failed} of ${row.jobs.total} jobs failed in "${name}"${where}.`;
    }
    return `"${name}"${where} failed.`;
  }
  // A workflow Galaxy refused to schedule fails with no job errors at all, so
  // counting jobs there would invent them.
  const jobs = bad.reduce((sum, row) => sum + row.jobs.failed, 0);
  return jobs > 0
    ? `${plural(jobs, "job", "jobs")} failed across ${plural(bad.length, "run", "runs")}.`
    : `${plural(bad.length, "run", "runs")} failed.`;
}

/**
 * Where this run lives in Galaxy. Routes read off Galaxy's own client router:
 * `workflows/invocations/:invocationId/:tab?` and `jobs/:jobId/view`.
 *
 * The server URL comes out of the notebook, so it is treated as hostile: only
 * http(s) survives, and the id is encoded, so a `/` in it becomes `%2F` and it
 * can never grow a second path segment. `encodeURIComponent` leaves a dot
 * alone, so an id of `..` still normalizes away to the prefix -- a dead link,
 * not an escape, since the origin and any configured path prefix both hold.
 */
export function galaxyRunUrl(row: RunRow): string | null {
  if (!row.serverUrl || !row.id) return null;
  let base: URL;
  try {
    base = new URL(row.serverUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  const path =
    row.kind === "invocation"
      ? `workflows/invocations/${encodeURIComponent(row.id)}`
      : `jobs/${encodeURIComponent(row.id)}/view`;
  // A configured URL may carry a path prefix ("https://host/galaxy"); keep it.
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  try {
    return new URL(`${prefix}${path}`, base).toString();
  } catch {
    return null;
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

/**
 * How often to repaint the relative times already on screen. Not a poll: the
 * data arrives when the brain rewrites the notebook. Without it a run whose
 * poller has stopped keeps saying "checked 40 s ago" forever, which is the one
 * thing this panel must never do.
 */
const TICK_MS = 30_000;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function pct(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.max(0, Math.min(100, (part / total) * 100)).toFixed(1)}%`;
}

/**
 * What the unfinished jobs are called. On a run that is being shut down they
 * are mostly Galaxy's own deletes, which the brain's counter scores alongside
 * real errors -- so the only honest thing the panel can say about them is that
 * they did not finish.
 */
function unfinishedWord(row: RunRow): string {
  return row.state === "stopping" ? "did not finish" : "failed";
}

function progressBar(row: RunRow): HTMLElement | null {
  const { done, failed, total } = row.jobs;
  // A single job is its own progress bar; two states do not need a chart.
  if (total <= 1) return null;
  const bar = node("div", "dash-jobs-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute(
    "aria-label",
    `${done} of ${total} jobs finished${failed > 0 ? `, ${failed} ${unfinishedWord(row)}` : ""}`,
  );
  if (done > 0) {
    const span = node("span", "dash-jobs-bar-done");
    span.style.width = pct(done, total);
    bar.append(span);
  }
  // Not on a run being shut down: those are Galaxy's own deletes in the failed
  // counter, and a red stripe is the same claim the headline stopped making.
  if (failed > 0 && row.state !== "stopping") {
    const span = node("span", "dash-jobs-bar-fail");
    span.style.width = pct(failed, total);
    bar.append(span);
  }
  return bar;
}

/** The small print: steps, how long it has been going, when we last asked. */
export function metaLine(row: RunRow, now: number): string {
  const bits: string[] = [];
  if (row.steps) bits.push(`${row.steps.done} of ${row.steps.total} steps`);
  const started = formatAgo(row.submittedAt, now);
  if (started) bits.push(row.live ? `started ${started}` : `submitted ${started}`);
  // A job's stamp is not a heartbeat -- `isStaleTracked` exists to say so.
  // tickJobs asks every fifteen seconds and only writes on a change, so
  // "checked 3 h ago" on a job is a run we are asking about four times a
  // minute. What the stamp actually marks is the last change, and saying that
  // keeps this line agreeing with the "Last change" row in the details.
  const stamp = formatAgo(row.lastPolledAt, now);
  if (stamp) bits.push(row.kind === "job" ? `last change ${stamp}` : `checked ${stamp}`);
  // An invocation is stamped on every poll, so a missing stamp really does mean
  // nobody has asked. A job with no stamp has had nothing written about it
  // since it was recorded, which is the normal shape of a live tool run.
  else if (row.live) bits.push(row.kind === "job" ? "no change yet" : "not checked yet");
  if (row.serverHost) bits.push(safeName(row.serverHost));
  if (row.unconfirmed) bits.push("unconfirmed by Galaxy");
  return bits.join(" · ");
}

function detailRows(row: RunRow, now: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (row.step) out.push(["Plan step", `${row.step.number}. ${safeName(row.step.title)}`]);
  else if (row.anchor) out.push(["Notebook anchor", safeName(row.anchor)]);
  if (row.toolId) out.push(["Tool", safeName(row.toolId)]);
  out.push([row.kind === "invocation" ? "Invocation" : "Job", safeName(row.id)]);
  // hostOf falls back to the raw notebook string when the URL will not parse,
  // and the Galaxy state is a notebook field like any other.
  if (row.serverHost) out.push(["Galaxy", safeName(row.serverHost)]);
  if (row.galaxyState) out.push(["Galaxy state", safeName(row.galaxyState)]);
  if (row.jobs.total > 1) {
    const left = Math.max(0, row.jobs.total - row.jobs.done - row.jobs.failed);
    out.push([
      "Jobs",
      `${row.jobs.done} finished, ${row.jobs.failed} ${unfinishedWord(row)}, ${left} to go, ${row.jobs.total} in total`,
    ]);
  }
  const checked = formatAgo(row.lastPolledAt, now);
  // Same reason as metaLine: on a job the stamp is the last change, not the
  // last check, and only the invocation poller rewrites its block every tick.
  if (checked) out.push([row.kind === "invocation" ? "Last checked" : "Last change", checked]);
  return out;
}

/**
 * Show the brain's own note when it says something the headline cannot: why a
 * terminal run ended, or what is failing inside one that is still going. On a
 * healthy running row it would only repeat the counts.
 */
function shouldShowSummary(row: RunRow): boolean {
  // `stopping` is live and deliberately raises no attention, so neither arm
  // catches it -- and it is the one live state where the brain's sentence says
  // something the headline cannot: which of the jobs had finished before the
  // user stopped it.
  return row.summary !== null && (!row.live || needsAttention(row) || row.state === "stopping");
}

function renderRow(row: RunRow, now: number, compact: boolean, openIds: Set<string>): HTMLElement {
  const item = node("section", "dash-jobs-row");
  item.dataset.runId = row.id;
  item.dataset.state = row.state;
  if (needsAttention(row)) item.classList.add("is-failed");
  if (row.stale) item.classList.add("is-stale");
  if (!row.live && !needsAttention(row)) item.classList.add("is-done");

  // The label is a workflow name out of the notebook and the step title comes
  // from the plan, so both are model-written: a bidi override in either would
  // render the row in an order nobody wrote.
  const name = safeNameOr(row.label || row.id, "(unnamed run)");
  const title = node("div", "dash-jobs-title", name);
  title.title = row.step ? `${name} -- step ${row.step.number}, ${safeName(row.step.title)}` : name;
  item.append(title);

  if (!compact) {
    const bar = progressBar(row);
    if (bar) item.append(bar);
  }

  // A stale row must not wear the colour and the pulse of the state it can no
  // longer vouch for.
  const shownState = row.stale ? "unknown" : row.state;
  const state = node("div", `dash-jobs-state state-${shownState}`);
  const glyph = node("span", "dash-jobs-glyph", stateGlyph(shownState));
  // The word beside it says the same thing; "black circle Running" does not
  // help anyone listening to this.
  glyph.setAttribute("aria-hidden", "true");
  state.append(glyph);
  state.append(document.createTextNode(row.stale ? "Can't tell" : stateWord(row.state)));
  item.append(state);

  if (!compact) {
    item.append(node("p", "dash-jobs-say", describeRun(row, now)));
    if (shouldShowSummary(row)) {
      item.append(node("p", "dash-jobs-why", safeName(row.summary ?? "")));
    }
  }

  item.append(node("div", "dash-jobs-meta", metaLine(row, now)));

  if (!compact) {
    const href = galaxyRunUrl(row);
    if (href) {
      const link = node("a", "dash-jobs-link", "Open in Galaxy ↗");
      link.dataset.focusKey = `link:${row.id}`;
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
    }

    const details = node("details", "dash-jobs-raw");
    // Re-rendering replaces the node, so remember which rows the user opened;
    // this panel redraws every time the poller rewrites the notebook.
    details.open = openIds.has(row.id);
    details.addEventListener("toggle", () => {
      if (details.open) openIds.add(row.id);
      else openIds.delete(row.id);
    });
    const summary = node("summary", undefined, "Details");
    summary.dataset.focusKey = `details:${row.id}`;
    details.append(summary);
    const list = node("dl");
    for (const [term, value] of detailRows(row, now)) {
      list.append(node("dt", undefined, term));
      list.append(node("dd", undefined, value));
    }
    details.append(list);
    item.append(details);
  }

  return item;
}

/** The `data-focus-key` of whatever inside `root` has focus, if anything does. */
function focusedKeyIn(root: HTMLElement): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  return active.dataset.focusKey ?? null;
}

function restoreFocus(root: HTMLElement, key: string | null): void {
  if (!key) return;
  for (const candidate of root.querySelectorAll<HTMLElement>("[data-focus-key]")) {
    if (candidate.dataset.focusKey === key) {
      candidate.focus({ preventScroll: true });
      return;
    }
  }
}

function emptyCard(hidden: number, onShowAll: () => void): HTMLElement {
  const card = node("div", "dash-jobs-empty");
  card.append(node("strong", undefined, "Nothing is running on Galaxy right now."));
  if (hidden <= 0) {
    card.append(
      node(
        "span",
        undefined,
        "Workflow runs and single tool runs appear here as soon as the agent starts one.",
      ),
    );
    return card;
  }
  // "Finished" would be wrong for the cancelled and skipped ones in there.
  card.append(
    node(
      "span",
      undefined,
      hidden === 1 ? "One earlier run is hidden." : `${hidden} earlier runs are hidden.`,
    ),
  );
  const button = node("button", "dash-panel-btn", "Show everything");
  button.dataset.focusKey = "show-all";
  button.type = "button";
  button.addEventListener("click", onShowAll);
  card.append(button);
  return card;
}

// ── The widget ───────────────────────────────────────────────────────────────

export const jobsWidget: WidgetDefinition<JobsConfig> = {
  type: "jobs",
  label: "Running on Galaxy",
  description: "Galaxy workflow runs and tool runs, what failed, and how fresh the numbers are.",
  defaultConfig: JOBS_DEFAULT_CONFIG,

  mount(container, ctx): WidgetDispose {
    const config = normalizeJobsConfig(ctx.config);

    const root = node("div", "dash-jobs");
    // One element across renders, so a screen reader hears a failure once when
    // it appears rather than on every notebook rewrite.
    const alert = node("p", "dash-jobs-alert");
    alert.setAttribute("role", "status");
    alert.hidden = true;
    const alertGlyph = node("span", "dash-jobs-alert-glyph", "✕");
    alertGlyph.setAttribute("aria-hidden", "true");
    const alertText = node("span");
    alert.append(alertGlyph, alertText);
    const body = node("div", "dash-jobs-body");
    root.append(alert, body);
    container.append(root);

    const badge = node("span", "dash-jobs-count zero", "0");
    const showBtn = node("button", "dash-panel-btn");
    showBtn.type = "button";
    showBtn.textContent = config.show === "all" ? "all" : "active";
    showBtn.title =
      config.show === "all"
        ? "Showing every run. Click to show only what is running or failed."
        : "Showing what is running or failed. Click to show every run.";
    // "all" on its own is not an accessible name, and a toggle has to say which
    // way it is set. The title is a tooltip and AT does not reliably read it.
    showBtn.setAttribute("aria-label", "Show every run");
    showBtn.setAttribute("aria-pressed", String(config.show === "all"));
    showBtn.classList.toggle("active", config.show === "all");
    showBtn.addEventListener("click", () =>
      ctx.setConfig({ show: config.show === "all" ? "active" : "all" }),
    );
    ctx.header.append(badge, showBtn);

    const openIds = new Set<string>();
    let snapshot: InvocationSnapshot = ctx.sources.invocations.get();
    let lastAlert: string | null = null;

    const render = (): void => {
      const now = Date.now();
      // Both sources are staged from the same notebook push and notified in
      // order, so the plan read here is this turn's, not last turn's.
      const rows = toRunRows(snapshot, ctx.sources.plan.get().plans, now);
      const shown = config.show === "all" ? rows : rows.filter(isActiveRun);

      const message = attentionMessage(rows);
      if (message !== lastAlert) {
        alertText.textContent = message;
        alert.hidden = message === "";
        lastAlert = message;
      }

      const active = rows.filter((row) => row.live).length;
      const failing = rows.filter(needsAttention).length;
      badge.textContent = String(failing > 0 ? failing : active);
      badge.className = `dash-jobs-count${failing > 0 ? " bad" : active === 0 ? " zero" : ""}`;
      const badgeText =
        failing > 0
          ? `${plural(failing, "run needs", "runs need")} your attention`
          : `${plural(active, "run is", "runs are")} still going`;
      badge.title = badgeText;
      // Otherwise its accessible name is a bare digit.
      badge.setAttribute("aria-label", badgeText);

      // The whole list is rebuilt on every notebook push, and the poller
      // rewrites the notebook every fifteen seconds while a workflow is live.
      // Anything the user was in the middle of has to survive that: the
      // disclosures are handled by openIds, and these two are the rest of it.
      // Without the focus restore a keyboard user gets fifteen seconds per
      // attempt to reach the Galaxy link.
      const focusKey = focusedKeyIn(body);
      const scrollTop = container.scrollTop;

      body.textContent = "";
      if (shown.length === 0) {
        body.append(emptyCard(rows.length, () => ctx.setConfig({ show: "all" })));
      } else {
        const list = node("div", "dash-jobs-rows");
        for (const row of shown.slice(0, config.limit)) {
          list.append(renderRow(row, now, config.compact, openIds));
        }
        body.append(list);

        const hidden = shown.length - Math.min(shown.length, config.limit);
        if (hidden > 0) body.append(node("p", "dash-jobs-more", `${hidden} more not shown.`));
      }

      restoreFocus(body, focusKey);
      // After the focus restore, which can scroll on its own in some browsers
      // however politely it is asked not to.
      container.scrollTop = scrollTop;
    };

    ctx.subscribe(ctx.sources.invocations, (next) => {
      snapshot = next;
      render();
    });

    // Times on screen age on their own, and nothing else wakes this panel once
    // the notebook stops changing -- which is exactly when staleness matters.
    // Through onDispose, not the returned dispose: a widget that throws never
    // gets to return one, and this interval would outlive the error card.
    //
    // The throw has to be handed to ctx.fail by hand. A subscription gets that
    // for free, but a timer callback that throws just disappears into the event
    // loop: the panel would quietly stop updating and the host's error card,
    // which is the whole point of the isolation, would never appear.
    const timer = setInterval(() => {
      try {
        render();
      } catch (err) {
        ctx.fail(err);
      }
    }, TICK_MS);
    ctx.onDispose(() => clearInterval(timer));

    return () => {
      container.textContent = "";
    };
  },
};
