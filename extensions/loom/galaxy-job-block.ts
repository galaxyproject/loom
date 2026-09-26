/**
 * `loom-job` notebook blocks: the tool-run equivalent of `loom-invocation`.
 *
 * The background poller advances work by scanning the notebook for in-flight
 * blocks, but it only ever knew about workflow invocations. A session driven
 * with single Galaxy *tool* runs recorded nothing pollable, so every tick took
 * the cheap early-return path, nothing advanced, no completion toast fired --
 * and the analysis sat still until the user typed "status?" (#413).
 *
 * Deliberately a separate fence rather than a flag on InvocationYaml: an
 * invocation id and a job id go to different Galaxy endpoints, and a job id
 * parsed as an invocation would send the existing polling tools to
 * /api/invocations/<job id> and fail. Separate types keep that mistake
 * unrepresentable.
 *
 * Format matches loom-invocation: line-oriented and grep-friendly, so the
 * blocks stay readable in a diff and survive hand edits.
 *
 * ```loom-job
 * job_id: abc123
 * galaxy_server_url: https://usegalaxy.org
 * notebook_anchor: plan-1-step-3
 * label: BWA alignment
 * tool_id: bwa_mem
 * submitted_at: 2026-08-12T15:30:00Z
 * status: in_progress
 * summary: ""
 * ```
 */

import {
  isNotebookFenceOpen,
  notebookFenceOpen,
  replaceNotebookBlocks,
} from "../../shared/notebook-fences.js";

export interface JobYaml {
  jobId: string;
  galaxyServerUrl: string;
  notebookAnchor: string;
  label: string;
  toolId?: string;
  submittedAt: string;
  status: "in_progress" | "completed" | "failed" | "cancelled" | "skipped";
  summary?: string;
  /**
   * Whether Galaxy confirmed this job id exists at record time. `false` means
   * the record tool asked and got no answer, not that the job is fake; the
   * poller sets it true on its first successful poll. Absent means the block
   * predates the field. Mirrors the same field on `InvocationYaml`.
   */
  serverVerified?: boolean;
  /** Galaxy's raw job state at the last poll, kept for display and debugging. */
  galaxyState?: string;
  lastPolledAt?: string;
}

const JOB_FENCE_OPEN = notebookFenceOpen("job");
const JOB_FENCE_CLOSE = "```";

/**
 * How each Galaxy job state (JobState in lib/galaxy/schema/schema.py) lands in
 * the block. A state listed here stops the polling; anything absent -- known
 * running states and any state Galaxy adds later -- leaves the block
 * in_progress, which is the safe default: we keep watching rather than
 * declaring an outcome we can't name.
 *
 * Two distinctions this table exists to make, both of which cost us a bug:
 *
 * Ending is not the same as failing. `deleted` and `stopped` are the user
 * cancelling their own job, and `skipped` is a workflow conditional choosing
 * not to run a step. Reporting those as failures sends the agent off to
 * investigate a malfunction that never happened -- Galaxy's own workflow UI
 * counts skipped alongside successful jobs.
 *
 * Ending is also not the same as heading for the exit. `deleting` and `stop`
 * (the wire value of STOPPING) are transitional: Galaxy's job handler advances
 * them to `deleted` and `stopped`. Treating them as terminal freezes the block
 * on a state the job has already left, and because the poller only revisits
 * in_progress blocks, nothing ever corrects it.
 *
 * `paused` is likewise not terminal: it resumes when its inputs arrive, or when
 * the user resumes it explicitly.
 */
const JOB_STATE_OUTCOME: Readonly<Record<string, Exclude<JobYaml["status"], "in_progress">>> = {
  ok: "completed",
  error: "failed",
  failed: "failed",
  deleted: "cancelled",
  stopped: "cancelled",
  skipped: "skipped",
};

/**
 * Every status the block may carry. Parsing has to recognise all of them: a
 * terminal status it doesn't know reads back as in_progress, so the poller
 * picks the job up again, rewrites the same outcome, and re-announces it on
 * every tick.
 */
const JOB_STATUSES: readonly JobYaml["status"][] = [
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "skipped",
];

function isJobStatus(value: string | undefined): value is JobYaml["status"] {
  return !!value && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminalJobState(state: string | undefined): boolean {
  if (!state) return false;
  return state.toLowerCase() in JOB_STATE_OUTCOME;
}

/** Map a Galaxy job state onto the block's coarse status. */
export function jobStatusFromGalaxyState(state: string | undefined): JobYaml["status"] {
  if (!state) return "in_progress";
  return JOB_STATE_OUTCOME[state.toLowerCase()] ?? "in_progress";
}

function escapeYaml(value: string): string {
  // Same conservative rule the invocation block uses: quote anything that
  // could be read as YAML structure, leave plain scalars alone.
  if (value === "") return '""';
  if (/^[\w .\-/]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function unescapeYaml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** Render a job as a `loom-job` fenced block, trailing newline included. */
export function renderJobYaml(job: JobYaml): string {
  const lines: string[] = [
    JOB_FENCE_OPEN,
    `job_id: ${job.jobId}`,
    `galaxy_server_url: ${job.galaxyServerUrl}`,
    `notebook_anchor: ${job.notebookAnchor}`,
    `label: ${escapeYaml(job.label)}`,
  ];
  if (job.toolId) lines.push(`tool_id: ${job.toolId}`);
  lines.push(`submitted_at: ${job.submittedAt}`);
  lines.push(`status: ${job.status}`);
  lines.push(`summary: ${escapeYaml(job.summary ?? "")}`);
  if (job.serverVerified !== undefined) lines.push(`server_verified: ${job.serverVerified}`);
  if (job.galaxyState) lines.push(`galaxy_state: ${job.galaxyState}`);
  if (job.lastPolledAt) lines.push(`last_polled_at: ${job.lastPolledAt}`);
  lines.push(JOB_FENCE_CLOSE);
  return lines.join("\n") + "\n";
}

function parseBooleanField(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

function parseJobBlock(blockLines: string[]): JobYaml | null {
  const map = new Map<string, string>();
  for (const line of blockLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const jobId = map.get("job_id");
  if (!jobId) return null; // a block without an id is not pollable
  const status = map.get("status");
  return {
    jobId,
    galaxyServerUrl: map.get("galaxy_server_url") ?? "",
    notebookAnchor: map.get("notebook_anchor") ?? "",
    label: unescapeYaml(map.get("label") ?? ""),
    toolId: map.get("tool_id") || undefined,
    submittedAt: map.get("submitted_at") ?? "",
    status: isJobStatus(status) ? status : "in_progress",
    summary: unescapeYaml(map.get("summary") ?? "") || undefined,
    // Absent or unreadable both mean "nobody has claimed this", which is the
    // honest default for a flag about a server round trip.
    serverVerified: parseBooleanField(map.get("server_verified")),
    galaxyState: map.get("galaxy_state") || undefined,
    lastPolledAt: map.get("last_polled_at") || undefined,
  };
}

interface BlockRange {
  jobId: string;
  start: number;
  end: number;
}

function findJobBlockRanges(content: string): BlockRange[] {
  const ranges: BlockRange[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (isNotebookFenceOpen(lines[i], "job")) {
      const start = i;
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== JOB_FENCE_CLOSE) end++;
      const parsed = parseJobBlock(lines.slice(i + 1, end));
      if (parsed) ranges.push({ jobId: parsed.jobId, start, end });
      i = end + 1;
    } else {
      i++;
    }
  }
  return ranges;
}

/** Every parseable `loom-job` block in the notebook. Invalid blocks are skipped. */
export function findJobBlocks(content: string): JobYaml[] {
  const result: JobYaml[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (isNotebookFenceOpen(lines[i], "job")) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== JOB_FENCE_CLOSE) end++;
      const parsed = parseJobBlock(lines.slice(start, end));
      if (parsed) result.push(parsed);
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

/**
 * Upsert a `loom-job` block keyed by `job_id`: replace in place when the id is
 * already present, otherwise append at the end.
 */
export function upsertJobBlock(content: string, job: JobYaml): string {
  const matching = findJobBlockRanges(content).filter((b) => b.jobId === job.jobId);
  const newBlock = renderJobYaml(job).trimEnd().split("\n");
  if (matching.length > 0) return replaceNotebookBlocks(content, matching, newBlock);

  const trimmed = content.replace(/\s+$/, "");
  const sep = trimmed.length > 0 ? "\n\n" : "";
  return trimmed + sep + newBlock.join("\n") + "\n";
}

/**
 * What one poll learned. Deliberately not a whole JobYaml: `label`,
 * `notebook_anchor` and `submitted_at` belong to whoever recorded the job, and
 * writing back a copy captured before the Galaxy round trip would clobber an
 * edit made in the meantime -- the same hazard the invocation poller documents.
 */
export interface JobPollUpdate {
  jobId: string;
  /**
   * The outcome this poll decided, or omitted for an update that isn't about
   * the outcome at all -- a verification-only write, say. Omitting is not the
   * same as passing the status the caller last saw: that copy predates whatever
   * landed while we were talking to Galaxy, and writing it back would revert
   * another writer's transition.
   */
  status?: JobYaml["status"];
  galaxyState?: string;
  lastPolledAt: string;
  summary?: string;
  /**
   * True when this update came from a Galaxy round trip that answered, which is
   * proof the id exists. Same rule as the invocation side: it clears a block
   * recorded `server_verified: false` and leaves an unstamped one alone.
   */
  serverVerified?: boolean;
}

/** Apply a poll result to whichever block carries that job id. No-op if absent. */
export function applyJobPollUpdate(content: string, update: JobPollUpdate): string {
  const current = findJobBlocks(content).find((j) => j.jobId === update.jobId);
  if (!current) return content;
  return upsertJobBlock(content, {
    ...current,
    status: update.status ?? current.status,
    galaxyState: update.galaxyState ?? current.galaxyState,
    lastPolledAt: update.lastPolledAt,
    summary: update.summary ?? current.summary,
    serverVerified:
      update.serverVerified && current.serverVerified === false ? true : current.serverVerified,
  });
}
