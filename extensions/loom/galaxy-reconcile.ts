/**
 * Reconcile: ask Galaxy what is in the history, and make the notebook account
 * for all of it.
 *
 * The submission hook records what it watches happen. What it cannot watch:
 * a turn that died between the submit and the result, a run started from
 * code mode or from Galaxy's own UI while Loom was open, a session resumed
 * after a crash. Galaxy is the source of truth and the notebook is a
 * reconciled projection of it, so this lists the bound history's invocations
 * and jobs and writes a block for every one no block claims -- as
 * `submitted_by: unknown` and `notebook_anchor: unattributed`, because the
 * harness did not see who made it or for which step, and saying so is the
 * point. A `reconcile.unattributed` row goes with each.
 *
 * The other direction too: a block whose id Galaxy now answers "no such
 * thing" for is downgraded to `server_verified: false`, with a warning row.
 * Only a downgrade -- a fresh Galaxy answer is the only thing that sets it
 * true, and that stays the poller's job.
 *
 * Terminal states seen in the listing are not written here. A block that is
 * in flight on disk and finished on Galaxy is handed to the poller's own
 * transition path (`pollGalaxyNow`), so there is one place that decides a run
 * ended, toasts it, and queues the follow-up.
 *
 * Runs on session start (the reconnect path: a session ending never meant the
 * remote work stopped), after `galaxy_connect`, every RECONCILE_EVERY_N_TICKS
 * poller ticks, and on `/reconcile`. Idempotent: a second run over the same
 * history finds every id already claimed and writes nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "path";
import { MCP_FAMILY, type GalaxyToolFamily } from "../../shared/galaxy-mcp-tools.js";
import { appendActivityEvent } from "./activity";
import {
  INVOCATION_SCHEDULING_DONE,
  galaxyGetInvocation,
  galaxyListHistoryInvocations,
  galaxyListHistoryJobs,
  getGalaxyConfig,
  isGalaxyEncodedId,
  isGalaxyFetchOverridden,
  sameGalaxyServer,
  verifyGalaxyRun,
  type GalaxyJobListing,
  type GalaxyRunVerification,
  type InvocationDetail,
} from "./galaxy-api";
import { resetEnrichmentState, runEnrichmentPass, walkInvocationJobs } from "./galaxy-enrich";
import {
  findJobBlocks,
  isTerminalJobState,
  jobStatusFromGalaxyState,
  locateJobBlock,
  upsertJobBlock,
  type JobYaml,
} from "./galaxy-job-block";
import { findGalaxyPageBlocks } from "./galaxy-page-binding";
import { pollGalaxyNow, setCaptureTickHook } from "./galaxy-poller";
import {
  UNKNOWN,
  ensureAttemptRecord,
  listAttemptRecords,
  readReconcileState,
  type AttemptRecord,
  writeReconcileState,
  type ReconcileState,
} from "./galaxy-provenance";
import { idToken } from "./galaxy-submission";
import { UNATTRIBUTED } from "./galaxy-submission-capture";
import type { HarnessBlockFields } from "./harness-block-fields";
import {
  NotebookChangedError,
  findInvocationBlocks,
  locateInvocationBlock,
  readNotebook,
  statNotebook,
  upsertInvocationBlock,
  withNotebookLock,
  writeNotebook,
  type InvocationYaml,
} from "./notebook-writer";
import { evaluateRegistryAttempts, type EvaluationPass } from "./registry-evaluator";
import { getNotebookPath } from "./state";
import { ulid } from "./ulid";

/**
 * Every 20th poller tick: five minutes at the poller's 15 s cadence. A reconcile
 * is two listings plus a walk of any invocation still scheduling, so this keeps
 * it to a twentieth of the poll budget while work started in Galaxy's own UI
 * still shows up in the notebook within minutes rather than at the next restart.
 */
export const RECONCILE_EVERY_N_TICKS = 20;
const JOB_PAGE_SIZE = 500;
const MAX_JOB_PAGES = 10;
/**
 * Galaxy's own ceiling on `GET /api/invocations?limit=` (`le=100`); anything
 * higher is a 400 and the whole reconcile fails. The listing comes back
 * newest first by default, and galaxy-ops passes no offset, so a full page
 * means "maybe more" and is treated as incomplete.
 */
export const INVOCATION_LISTING_LIMIT = 100;
/**
 * The stamp is the newest `create_time` seen, in Galaxy's own clock, and the
 * next window starts this far before it: a job's row can commit after a
 * later-created one was already listed.
 */
const STAMP_MARGIN_MS = 10 * 60_000;
/** Direct existence checks per run, so a long notebook costs a bounded number of GETs. */
const MAX_VERIFY_PER_RUN = 100;

export type ReconcileTrigger =
  "session_start" | "galaxy_connect" | "tick" | "command" | "page_pull" | "page_resume";

export interface ReconcileDeps {
  listJobs: typeof galaxyListHistoryJobs;
  listInvocations: (
    historyId: string,
    limit: number,
  ) => Promise<
    {
      id: string;
      create_time?: string;
      state?: string;
      workflow_id?: string;
      history_id?: string;
    }[]
  >;
  getInvocation: (id: string) => Promise<InvocationDetail>;
  verify: (kind: "invocation" | "job", id: string) => Promise<GalaxyRunVerification>;
  now: () => number;
}

const defaultDeps: ReconcileDeps = {
  listJobs: (params) => galaxyListHistoryJobs(params),
  listInvocations: (historyId, limit) => galaxyListHistoryInvocations(historyId, limit),
  getInvocation: (id) => galaxyGetInvocation(id),
  verify: (kind, id) => verifyGalaxyRun(kind, id),
  now: () => Date.now(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Galaxy writes naive UTC timestamps (`2026-10-07T10:00:00.123456`). Read one
 * as UTC; NaN when it is not a time at all.
 */
export function parseGalaxyTime(value: string | undefined): number {
  if (!value) return NaN;
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/i.test(value);
  return Date.parse(hasZone ? value : `${value}Z`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The history this analysis is bound to, and where that answer came from.
 *
 * First choice is the history the harness itself last submitted into, read
 * from the protected attempt records -- notebook text can be edited to name
 * any history the account can see, and reconcile would then write that
 * history's work into this analysis. Only when the harness has submitted
 * nothing yet does the notebook's page binding decide, and the row says so.
 * Never the account's most-recently-used history: a guess here would pull
 * somebody's unrelated work in as this analysis's own.
 */
export function boundHistoryId(
  content: string,
  serverUrl: string,
  records: readonly AttemptRecord[],
): { historyId: string; source: "submission" | "page_binding" } | null {
  const submitted = records
    .filter((r) => r.origin === "submission" && !r.fixture)
    .filter((r) => r.history_id !== UNKNOWN && isGalaxyEncodedId(r.history_id))
    .filter((r) => sameGalaxyServer(r.galaxy_server_url, serverUrl))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .pop();
  if (submitted) return { historyId: submitted.history_id, source: "submission" };
  const binding = findGalaxyPageBlocks(content)
    .filter((b) => sameGalaxyServer(b.galaxyServerUrl, serverUrl))
    .pop();
  if (binding?.historyId && isGalaxyEncodedId(binding.historyId)) {
    return { historyId: binding.historyId, source: "page_binding" };
  }
  return null;
}

/**
 * When this analysis started, for a reconcile with no cursor yet. The cursor
 * is written on the first session start, so in the normal course this only
 * runs then and the answer is "now". An analysis that predates the cursor
 * starts at its earliest protected submission record. Never from the notebook
 * or the activity log: both are the agent's to edit, and an earlier start
 * widens the window to work that was never this analysis's.
 */
export function inferAnalysisStart(records: readonly AttemptRecord[], now: number): number {
  let earliest = now;
  for (const r of records) {
    if (r.origin !== "submission") continue;
    const t = Date.parse(r.created_at);
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  return earliest;
}

/** A label for a run nobody named. Galaxy's tool id when it is one clean token. */
function jobLabel(job: GalaxyJobListing): string {
  const tool = idToken(job.tool_id);
  return tool
    ? `${tool.split("/").slice(-2, -1)[0] ?? tool} (found on Galaxy)`
    : "job found on Galaxy";
}

// ─────────────────────────────────────────────────────────────────────────────
// The reconcile
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  historyId: string | null;
  since: string | null;
  unattributed: { kind: "invocation" | "job"; id: string; attemptId: string }[];
  unverified: { kind: "invocation" | "job"; id: string }[];
  /** In-flight blocks Galaxy says have ended; handed to the poller. */
  terminalSeen: number;
  /** Blocks recorded before enrichment existed, now given an attempt and a pending state. */
  adopted?: number;
  /** Why the listing half did not run, when it didn't. */
  skipped?: string;
  /** Standalone jobs were held back; the cursor stays where it was. */
  incomplete?: boolean;
  error?: string;
}

/** Ids checked this process; a block is verified once per session, not every run. */
const verifiedThisSession = new Set<string>();
const reportedIncomplete = new Set<string>();

export function resetReconcileState(): void {
  verifiedThisSession.clear();
  reportedIncomplete.clear();
}

/**
 * Ids already on the record: every block's own id, and every job an attempt's
 * protected record names. Not the blocks' `jobs` summaries -- those are
 * notebook text, and a planted summary would otherwise hide a real run from
 * reconcile for good.
 */
function claimedIds(
  content: string,
  records: readonly AttemptRecord[],
  serverUrl: string,
): { invocations: Set<string>; jobs: Set<string> } {
  const invocations = new Set<string>();
  const jobs = new Set<string>();
  for (const block of findInvocationBlocks(content)) invocations.add(block.invocationId);
  for (const block of findJobBlocks(content)) jobs.add(block.jobId);
  for (const r of records) {
    if (!sameGalaxyServer(r.galaxy_server_url, serverUrl)) continue;
    if (r.ids.invocation_id) invocations.add(r.ids.invocation_id);
    for (const id of r.ids.job_ids ?? []) jobs.add(id);
    for (const id of Object.keys(r.jobs)) jobs.add(id);
  }
  return { invocations, jobs };
}

/**
 * List what Galaxy has, decide what is unclaimed. Pure apart from the deps,
 * so the decisions are testable without a notebook on disk.
 */
export async function surveyHistory(
  content: string,
  serverUrl: string,
  historyId: string,
  sinceMs: number,
  deps: ReconcileDeps,
  records: readonly AttemptRecord[] = [],
): Promise<{
  newInvocations: { id: string; create_time?: string; workflow_id?: string }[];
  newJobs: GalaxyJobListing[];
  seen: { invocations: Map<string, string | undefined>; jobs: Map<string, string | undefined> };
  newestCreate: number;
  /** Set when step jobs could not be told apart from standalone ones. */
  jobsWithheld?: string;
  /** Set when a listing may have been cut short; the cursor must not move past it. */
  incomplete?: string;
}> {
  const claimed = claimedIds(content, records, serverUrl);
  // A row Galaxy says belongs to another history is not this history's work,
  // whatever list it arrived in.
  const inHistory = (h: string | undefined) => !h || h === historyId;
  let newestCreate = NaN;
  const note = (t: string | undefined) => {
    const ms = parseGalaxyTime(t);
    if (Number.isFinite(ms) && !(ms <= newestCreate)) newestCreate = ms;
  };
  const inWindow = (t: string | undefined) => {
    const ms = parseGalaxyTime(t);
    // No usable time: keep it. Dropping it would hide work, and the block-id
    // check still stops it being written twice.
    return !Number.isFinite(ms) || ms >= sinceMs;
  };

  const rawInvocations = await deps.listInvocations(historyId, INVOCATION_LISTING_LIMIT);
  let incomplete: string | undefined;
  // galaxy-ops' listing has no offset, so a full page may not be all of them.
  if (rawInvocations.length >= INVOCATION_LISTING_LIMIT) {
    incomplete = `the history has at least ${INVOCATION_LISTING_LIMIT} invocations; only the newest were listed`;
  }
  const listed = rawInvocations.filter((i) => isGalaxyEncodedId(i.id) && inHistory(i.history_id));
  const seenInvocations = new Map<string, string | undefined>();
  for (const inv of listed) {
    seenInvocations.set(inv.id, inv.state);
    note(inv.create_time);
  }
  const newInvocations = listed.filter(
    (i) => inWindow(i.create_time) && !claimed.invocations.has(i.id),
  );

  const jobs: GalaxyJobListing[] = [];
  const sinceDay = iso(sinceMs).slice(0, 10);
  for (let page = 0; ; page++) {
    if (page >= MAX_JOB_PAGES) {
      incomplete = `more than ${MAX_JOB_PAGES * JOB_PAGE_SIZE} jobs since ${sinceDay}`;
      break;
    }
    const rows = await deps.listJobs({
      historyId,
      sinceDay,
      limit: JOB_PAGE_SIZE,
      offset: page * JOB_PAGE_SIZE,
    });
    jobs.push(...rows.filter((r) => inHistory(r.history_id)));
    if (rows.length < JOB_PAGE_SIZE) break;
  }
  const seenJobs = new Map<string, string | undefined>();
  for (const job of jobs) {
    if (!isGalaxyEncodedId(job.id)) continue;
    seenJobs.set(job.id, job.state);
    note(job.create_time);
  }

  // A workflow's step jobs are in the job listing too, and they belong to the
  // invocation, not to a standalone block of their own. Every invocation that
  // could own a job in this window is walked: the new ones, the ones still
  // scheduling, and the recorded ones whose job list isn't on the block yet.
  const knownJobs = new Map(
    records.filter((r) => r.ids.invocation_id).map((r) => [r.ids.invocation_id!, r]),
  );
  const recordedInvocations = findInvocationBlocks(content).filter((b) => {
    if (!sameGalaxyServer(b.galaxyServerUrl, serverUrl)) return false;
    if (b.status === "in_progress") return true;
    // Its jobs are already claimed once its protected record lists them.
    const r = knownJobs.get(b.invocationId);
    return !r || Object.keys(r.jobs).length === 0;
  });
  const toWalk = new Set<string>([
    ...newInvocations.map((i) => i.id),
    ...listed.filter((i) => !INVOCATION_SCHEDULING_DONE.has(i.state ?? "")).map((i) => i.id),
    ...recordedInvocations.map((b) => b.invocationId).filter((id) => isGalaxyEncodedId(id)),
  ]);
  const stepJobs = new Set<string>(claimed.jobs);
  let jobsWithheld: string | undefined;
  for (const id of toWalk) {
    try {
      const inv = await deps.getInvocation(id);
      if (!inv || inv.id !== id) throw new Error(`Galaxy answered for a different invocation`);
      for (const job of await walkInvocationJobs(inv, deps.getInvocation)) stepJobs.add(job.jobId);
    } catch (err) {
      // Without this invocation's jobs, a job in the listing could be one of
      // its steps, and writing that as a standalone unattributed run would be
      // a wrong record. Hold the jobs back until the walk succeeds.
      jobsWithheld = `could not list the jobs of invocation ${id}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // A cut-short listing means an invocation we did not see could own any of
  // these, so none of them is written as standalone this run.
  const newJobs =
    jobsWithheld || incomplete
      ? []
      : jobs.filter(
          (j) =>
            isGalaxyEncodedId(j.id) &&
            inWindow(j.create_time) &&
            !claimed.jobs.has(j.id) &&
            !stepJobs.has(j.id),
        );
  return {
    newInvocations,
    newJobs,
    seen: { invocations: seenInvocations, jobs: seenJobs },
    newestCreate,
    ...(jobsWithheld ? { jobsWithheld } : {}),
    ...(incomplete ? { incomplete } : {}),
  };
}

function record(dir: string, kind: string, payload: Record<string, unknown>): void {
  appendActivityEvent(dir, {
    timestamp: new Date().toISOString(),
    kind,
    source: "galaxy-reconcile",
    payload,
  });
}

/** Read-modify-write the notebook under the lock, retrying a lost compare-and-swap. */
async function casNotebook(nbPath: string, apply: (content: string) => string): Promise<void> {
  await withNotebookLock(nbPath, async () => {
    for (let attempt = 0; ; attempt++) {
      const stamp = await statNotebook(nbPath);
      const content = await readNotebook(nbPath);
      const next = apply(content);
      if (next === content) return;
      try {
        await writeNotebook(nbPath, next, stamp ?? undefined);
        return;
      } catch (err) {
        if (!(err instanceof NotebookChangedError) || attempt >= 2) throw err;
      }
    }
  });
}

/**
 * Reconcile the notebook against one history, since `sinceMs`. Exported as the
 * unit the brief names: `reconcile(historyId, since)`.
 */
export async function reconcile(
  historyId: string,
  sinceMs: number,
  options: {
    trigger: ReconcileTrigger;
    deps?: Partial<ReconcileDeps>;
    historySource?: "submission" | "page_binding";
  },
): Promise<ReconcileResult & { newestCreate: number }> {
  const deps: ReconcileDeps = { ...defaultDeps, ...options.deps };
  const nbPath = getNotebookPath();
  const server = getGalaxyConfig()?.url;
  const result: ReconcileResult & { newestCreate: number } = {
    historyId,
    since: iso(sinceMs),
    unattributed: [],
    unverified: [],
    terminalSeen: 0,
    newestCreate: NaN,
  };
  if (!nbPath || !server) return { ...result, skipped: "no notebook or no Galaxy credentials" };
  const dir = path.dirname(nbPath);

  result.adopted = await adoptRecordedBlocks(nbPath, server, options.trigger);
  const content = await readNotebook(nbPath);
  const records = await listAttemptRecords(dir);
  const survey = await surveyHistory(content, server, historyId, sinceMs, deps, records);
  result.newestCreate = survey.newestCreate;
  // Blocks written from fixture answers make no claim a server never made,
  // the same rule the submission replay seam follows.
  const fromFixture = isGalaxyFetchOverridden();

  // What Galaxy says has ended for a block still in flight on disk goes to the
  // poller, which owns transitions.
  for (const block of findJobBlocks(content)) {
    const state = survey.seen.jobs.get(block.jobId);
    if (block.status === "in_progress" && isTerminalJobState(state)) result.terminalSeen++;
  }

  // Write every unclaimed run in one locked compare-and-swap. The presence
  // checks are repeated against the bytes being replaced, so a submission
  // the hook recorded in the meantime is not written a second time.
  const pending = [
    ...survey.newInvocations.map((inv) => ({
      kind: "invocation" as const,
      inv,
      attemptId: ulid(),
    })),
    ...survey.newJobs.map((job) => ({ kind: "job" as const, job, attemptId: ulid() })),
  ];
  const written: typeof pending = [];
  if (pending.length > 0) {
    await casNotebook(nbPath, (current) => {
      written.length = 0;
      let next = current;
      for (const item of pending) {
        const harness: HarnessBlockFields = {
          attemptId: item.attemptId,
          historyId,
          submittedBy: "unknown",
          enrichment: "pending",
          enrichmentAttempts: 0,
        };
        if (item.kind === "invocation") {
          if (locateInvocationBlock(next, item.inv.id).present) continue;
          const created = parseGalaxyTime(item.inv.create_time);
          const workflow = idToken(item.inv.workflow_id);
          const block: InvocationYaml = {
            invocationId: item.inv.id,
            galaxyServerUrl: server,
            notebookAnchor: UNATTRIBUTED,
            label: workflow ? `workflow ${workflow} (found on Galaxy)` : "workflow found on Galaxy",
            submittedAt: Number.isFinite(created) ? iso(created) : iso(deps.now()),
            // Whether it has ended is the poller's call, not a listing's.
            status: "in_progress",
            ...(fromFixture ? {} : { serverVerified: true }),
          };
          next = upsertInvocationBlock(next, block, harness);
        } else {
          if (locateJobBlock(next, item.job.id).present) continue;
          const created = parseGalaxyTime(item.job.create_time);
          const toolId = idToken(item.job.tool_id);
          const terminal = isTerminalJobState(item.job.state);
          const block: JobYaml = {
            jobId: item.job.id,
            galaxyServerUrl: server,
            notebookAnchor: UNATTRIBUTED,
            label: jobLabel(item.job),
            ...(toolId ? { toolId } : {}),
            submittedAt: Number.isFinite(created) ? iso(created) : iso(deps.now()),
            // Already over when we found it: written as such, the way capture
            // writes a job that finished before its call returned, so the
            // poller does not "discover" it ended and wake the agent for it.
            ...(terminal
              ? { status: jobStatusFromGalaxyState(item.job.state), galaxyState: item.job.state }
              : { status: "in_progress" as const }),
            ...(fromFixture ? {} : { serverVerified: true }),
          };
          const version = idToken(item.job.tool_version);
          next = upsertJobBlock(next, block, {
            ...harness,
            jobs: [
              {
                jobId: item.job.id,
                ...(toolId ? { toolId } : {}),
                ...(version ? { toolVersion: version } : {}),
              },
            ],
          });
        }
        written.push(item);
      }
      return next;
    });
  }

  for (const item of written) {
    const id = item.kind === "invocation" ? item.inv.id : item.job.id;
    try {
      await ensureAttemptRecord(dir, {
        attemptId: item.attemptId,
        kind: item.kind === "invocation" ? "invocation" : "jobs",
        galaxyServerUrl: server,
        historyId,
        submittedBy: "unknown",
        ids: item.kind === "invocation" ? { invocation_id: id } : { job_ids: [id] },
        origin: "reconcile",
        ...(item.kind === "job"
          ? {
              seeds: {
                [id]: {
                  ...(idToken(item.job.tool_id) ? { tool_id: idToken(item.job.tool_id) } : {}),
                  ...(idToken(item.job.tool_version)
                    ? { tool_version: idToken(item.job.tool_version) }
                    : {}),
                },
              },
            }
          : {}),
      });
    } catch (err) {
      // Enrichment creates it later from the block; the run is recorded either way.
      console.error("[reconcile] provenance record not written:", err);
    }
    result.unattributed.push({ kind: item.kind, id, attemptId: item.attemptId });
    record(dir, "reconcile.unattributed", {
      block_kind: item.kind,
      id,
      attempt_id: item.attemptId,
      history_id: historyId,
      history_source: options.historySource ?? null,
      trigger: options.trigger,
      ...(item.kind === "job"
        ? { tool_id: idToken(item.job.tool_id) ?? null, galaxy_state: item.job.state ?? null }
        : { workflow_id: idToken(item.inv.workflow_id) ?? null }),
    });
  }

  if (survey.jobsWithheld || survey.incomplete) {
    result.error = survey.jobsWithheld ?? survey.incomplete;
    result.incomplete = true;
  }
  // Said once per session per reason: a history past galaxy-ops' listing cap
  // stays that way, and a row every five minutes would bury everything else.
  if (result.error && !reportedIncomplete.has(result.error)) {
    reportedIncomplete.add(result.error);
    record(dir, "reconcile.incomplete", {
      history_id: historyId,
      trigger: options.trigger,
      reason: result.error,
    });
  }

  // The existence check: once per block per session, on the triggers where a
  // person or a reconnect is asking, not on the background cadence.
  if (options.trigger !== "tick") {
    result.unverified = await downgradeAbsent(nbPath, server, survey.seen, deps, options.trigger);
  }
  return result;
}

/**
 * Bring blocks that predate enrichment into it: an agent-recorded block, or
 * one from before capture, has no `enrichment` and no attempt id, so nothing
 * would ever fetch its details -- and without its job list on the block,
 * every reconcile would have to walk it again to tell its step jobs from
 * standalone ones. It gets a fresh attempt id and `enrichment: pending`.
 * `submitted_by` is left as it is: who submitted it is not something this
 * learns.
 */
async function adoptRecordedBlocks(
  nbPath: string,
  server: string,
  trigger: ReconcileTrigger,
): Promise<number> {
  const adopted: { kind: "invocation" | "job"; id: string; attemptId: string }[] = [];
  await casNotebook(nbPath, (current) => {
    adopted.length = 0;
    let next = current;
    for (const b of findInvocationBlocks(current)) {
      if (b.enrichment || b.attemptId || !sameGalaxyServer(b.galaxyServerUrl, server)) continue;
      const attemptId = ulid();
      next = upsertInvocationBlock(next, b, {
        attemptId,
        enrichment: "pending",
        enrichmentAttempts: 0,
      });
      adopted.push({ kind: "invocation", id: b.invocationId, attemptId });
    }
    for (const b of findJobBlocks(current)) {
      if (b.enrichment || b.attemptId || !sameGalaxyServer(b.galaxyServerUrl, server)) continue;
      const attemptId = ulid();
      next = upsertJobBlock(next, b, { attemptId, enrichment: "pending", enrichmentAttempts: 0 });
      adopted.push({ kind: "job", id: b.jobId, attemptId });
    }
    return next;
  });
  const dir = path.dirname(nbPath);
  for (const a of adopted) {
    record(dir, "reconcile.adopted", {
      block_kind: a.kind,
      id: a.id,
      attempt_id: a.attemptId,
      trigger,
    });
  }
  return adopted.length;
}

async function downgradeAbsent(
  nbPath: string,
  server: string,
  seen: { invocations: Map<string, unknown>; jobs: Map<string, unknown> },
  deps: ReconcileDeps,
  trigger: ReconcileTrigger,
): Promise<{ kind: "invocation" | "job"; id: string }[]> {
  const content = await readNotebook(nbPath);
  const candidates: { kind: "invocation" | "job"; id: string }[] = [];
  for (const b of findInvocationBlocks(content)) {
    if (b.serverVerified === false || seen.invocations.has(b.invocationId)) continue;
    if (!sameGalaxyServer(b.galaxyServerUrl, server)) continue;
    candidates.push({ kind: "invocation", id: b.invocationId });
  }
  for (const b of findJobBlocks(content)) {
    if (b.serverVerified === false || seen.jobs.has(b.jobId)) continue;
    if (!sameGalaxyServer(b.galaxyServerUrl, server)) continue;
    candidates.push({ kind: "job", id: b.jobId });
  }
  const absent: { kind: "invocation" | "job"; id: string; detail: string }[] = [];
  let checked = 0;
  for (const c of candidates) {
    const key = `${c.kind}:${c.id}`;
    if (verifiedThisSession.has(key)) continue;
    if (checked >= MAX_VERIFY_PER_RUN) break;
    checked++;
    const verdict = await deps.verify(c.kind, c.id);
    // Unreachable is not a verdict: leave the block and ask next session.
    if (verdict.outcome === "unreachable") continue;
    verifiedThisSession.add(key);
    if (verdict.outcome === "absent") absent.push({ ...c, detail: verdict.detail });
  }
  if (absent.length === 0) return [];

  const downgraded: typeof absent = [];
  await casNotebook(nbPath, (current) => {
    downgraded.length = 0;
    let next = current;
    for (const a of absent) {
      if (a.kind === "invocation") {
        const rec = locateInvocationBlock(next, a.id).record;
        if (!rec || rec.serverVerified === false) continue;
        next = upsertInvocationBlock(next, { ...rec, serverVerified: false });
      } else {
        const rec = locateJobBlock(next, a.id).record;
        if (!rec || rec.serverVerified === false) continue;
        next = upsertJobBlock(next, { ...rec, serverVerified: false });
      }
      downgraded.push(a);
    }
    return next;
  });
  const dir = path.dirname(nbPath);
  for (const a of downgraded) {
    record(dir, "reconcile.unverified", {
      block_kind: a.kind,
      id: a.id,
      trigger,
      detail: a.detail,
    });
  }
  return downgraded.map(({ kind, id }) => ({ kind, id }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Running it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the history and the window, reconcile, and move the cursor. The
 * cursor only moves forward, and only on a run whose listing succeeded.
 */
export async function runReconcile(
  trigger: ReconcileTrigger,
  deps?: Partial<ReconcileDeps>,
): Promise<ReconcileResult> {
  const nbPath = getNotebookPath();
  const server = getGalaxyConfig()?.url;
  const empty: ReconcileResult = {
    historyId: null,
    since: null,
    unattributed: [],
    unverified: [],
    terminalSeen: 0,
  };
  if (!nbPath || !server) return { ...empty, skipped: "no notebook or no Galaxy credentials" };
  const dir = path.dirname(nbPath);
  const now = (deps?.now ?? defaultDeps.now)();

  let content: string;
  try {
    content = await readNotebook(nbPath);
  } catch {
    return { ...empty, skipped: "notebook unreadable" };
  }
  const records = await listAttemptRecords(dir);
  let bound = boundHistoryId(content, server, records);

  let state: ReconcileState | null = await readReconcileState(dir);
  let stateDirty = false;
  if (!state) {
    state = {
      schema: 1,
      analysis_started_at: iso(inferAnalysisStart(records, now)),
      histories: {},
    };
    stateDirty = true;
  }
  // A page binding is notebook text, so it gets one say: the first history it
  // names is sealed into the cursor, and an edit after that cannot point
  // reconcile somewhere else. A harness submission still moves the binding,
  // since that is a protected record of where the work actually went.
  if (bound?.source === "page_binding") {
    const sealed = state.bound_histories?.[server];
    if (sealed) bound = { historyId: sealed, source: "page_binding" };
    else {
      state.bound_histories = { ...state.bound_histories, [server]: bound.historyId };
      stateDirty = true;
    }
  }
  if (stateDirty) {
    try {
      await writeReconcileState(dir, state);
    } catch (err) {
      console.error("[reconcile] cursor not written:", err);
    }
  }
  const historyId = bound?.historyId ?? null;

  if (!historyId) {
    // Nothing to list, but the existence half still applies to what is recorded.
    const unverified =
      trigger === "tick"
        ? []
        : await downgradeAbsent(
            nbPath,
            server,
            { invocations: new Map(), jobs: new Map() },
            { ...defaultDeps, ...deps },
            trigger,
          );
    return { ...empty, unverified, skipped: "no history is bound to this analysis yet" };
  }

  const key = `${server}|${historyId}`;
  const start = Date.parse(state.analysis_started_at);
  const stamp = Date.parse(state.histories[key]?.stamp ?? "");
  const sinceMs = Number.isFinite(stamp) ? Math.max(start, stamp - STAMP_MARGIN_MS) : start;

  let result: ReconcileResult & { newestCreate: number };
  try {
    result = await reconcile(historyId, sinceMs, {
      trigger,
      deps,
      historySource: bound?.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(dir, "reconcile.failed", { history_id: historyId, trigger, error: message });
    return { ...empty, historyId, since: iso(sinceMs), error: message };
  }

  if (Number.isFinite(result.newestCreate) && !result.error && !result.incomplete) {
    const prior = Number.isFinite(stamp) ? stamp : -Infinity;
    if (result.newestCreate > prior) {
      state.histories[key] = { stamp: iso(result.newestCreate) };
      try {
        await writeReconcileState(dir, state);
      } catch (err) {
        console.error("[reconcile] cursor not written:", err);
      }
    }
  }

  if (result.terminalSeen > 0) void pollGalaxyNow();
  const { newestCreate: _newest, ...rest } = result;
  return rest;
}

/**
 * Everything capture does after the submission, in one queue: reconcile, then
 * enrichment. One queue rather than independent timers because the two read
 * and write the same blocks, and because a `/reconcile` arriving while the
 * session-start run is still going must run after it, not race it.
 */
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  queued++;
  const run = queue.then(work, work).finally(() => {
    queued--;
  });
  queue = run.catch(() => undefined);
  return run;
}

export function followThrough(trigger: ReconcileTrigger | "enrich"): Promise<{
  reconcile?: ReconcileResult;
  enrichment: Awaited<ReturnType<typeof runEnrichmentPass>>;
  evaluation?: EvaluationPass;
}> {
  return enqueue(async () => {
    const reconciled = trigger === "enrich" ? undefined : await runReconcile(trigger);
    const enrichment = await runEnrichmentPass({ force: trigger === "command" });
    // Last, so it reads what this pass just learned. A failure here must not
    // cost the reconcile and enrichment results above.
    let evaluation: EvaluationPass | undefined;
    try {
      evaluation = await evaluateRegistryAttempts(trigger);
    } catch (err) {
      console.error("[registry] evaluation pass failed:", err);
    }
    return {
      ...(reconciled ? { reconcile: reconciled } : {}),
      enrichment,
      ...(evaluation ? { evaluation } : {}),
    };
  });
}

function summarize(result: {
  reconcile?: ReconcileResult;
  enrichment: Awaited<ReturnType<typeof runEnrichmentPass>>;
  evaluation?: EvaluationPass;
}): string {
  const r = result.reconcile;
  const lines: string[] = [];
  if (r?.skipped) lines.push(`Reconcile: ${r.skipped}.`);
  else if (r?.error && r.unattributed.length === 0)
    lines.push(`Reconcile did not finish: ${r.error}`);
  else if (r) {
    lines.push(
      r.unattributed.length > 0
        ? `Found ${r.unattributed.length} run(s) in history ${r.historyId} that no block recorded; written as unattributed.`
        : `Every run in history ${r.historyId} since ${r.since} is in the notebook.`,
    );
    if (r.error) lines.push(`Some jobs were held back: ${r.error}`);
  }
  if (r && r.unverified.length > 0) {
    lines.push(
      `${r.unverified.length} recorded run(s) are not on Galaxy any more; marked unverified.`,
    );
  }
  const e = result.enrichment;
  const enriched = [
    e.completed.length > 0 ? `${e.completed.length} enriched` : "",
    e.retried.length > 0 ? `${e.retried.length} will retry` : "",
    e.unavailable.length > 0 ? `${e.unavailable.length} unavailable` : "",
  ].filter(Boolean);
  if (enriched.length > 0) lines.push(`Run details: ${enriched.join(", ")}.`);
  const v = result.evaluation;
  if (v && v.evaluated.length > 0) {
    lines.push(`Re-evaluated ${v.evaluated.length} approved run(s) against Galaxy.`);
  }
  if (v && v.unreachable.length > 0) {
    lines.push(`${v.unreachable.length} approved run(s) couldn't be checked; will try again.`);
  }
  return lines.join("\n");
}

/**
 * Register reconcile and enrichment: session start, `galaxy_connect`, the
 * poller tick, and `/reconcile`.
 */
export function registerCaptureFollowThrough(
  pi: ExtensionAPI,
  family: GalaxyToolFamily = MCP_FAMILY,
): void {
  pi.on("session_start", async () => {
    resetEnrichmentState();
    resetReconcileState();
    // Not awaited: startup does not wait on Galaxy. `/reconcile` queues
    // behind it, so a person asking right away sees its result.
    void followThrough("session_start").catch((err) => {
      console.error("[reconcile] session start failed:", err);
    });
  });

  pi.on("tool_execution_end", async (event) => {
    // No bare family has a connect tool, so this trigger is inert there;
    // session_start, the tick and /reconcile carry reconcile instead.
    if (event.isError || family.toolName(event.toolName) !== "connect") return;
    void followThrough("galaxy_connect").catch((err) => {
      console.error("[reconcile] after connect failed:", err);
    });
  });

  setCaptureTickHook(async (tickNumber) => {
    // A tick never piles onto work already queued; the next one will come.
    if (queued > 0) return;
    await followThrough(tickNumber % RECONCILE_EVERY_N_TICKS === 0 ? "tick" : "enrich");
  });

  pi.registerCommand("reconcile", {
    description:
      "Check the bound Galaxy history against the notebook: record runs no block claims, and fetch details for finished runs now",
    handler: async (_args, ctx) => {
      const result = await followThrough("command");
      const text = summarize(result) || "Nothing to reconcile.";
      try {
        if (ctx.hasUI) ctx.ui.notify(text, "info");
      } catch {
        /* stale/headless context -- the activity rows still say what happened */
      }
    },
  });
}
