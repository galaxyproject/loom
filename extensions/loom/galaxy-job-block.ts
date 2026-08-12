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

export interface JobYaml {
  jobId: string;
  galaxyServerUrl: string;
  notebookAnchor: string;
  label: string;
  toolId?: string;
  submittedAt: string;
  status: "in_progress" | "completed" | "failed";
  summary?: string;
  /** Galaxy's raw job state at the last poll, kept for display and debugging. */
  galaxyState?: string;
  lastPolledAt?: string;
}

const JOB_FENCE_OPEN = "```loom-job";
const JOB_FENCE_CLOSE = "```";

/**
 * Galaxy job states that mean "stop polling this". Everything else (new,
 * queued, running, waiting, ...) leaves the block in_progress.
 *
 * `paused` is deliberately NOT terminal: a paused job resumes when its input
 * arrives, and marking it failed would strand work that is merely waiting.
 */
const TERMINAL_OK = new Set(["ok"]);
const TERMINAL_BAD = new Set(["error", "deleted", "deleting", "failed"]);

export function isTerminalJobState(state: string | undefined): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return TERMINAL_OK.has(s) || TERMINAL_BAD.has(s);
}

/** Map a Galaxy job state onto the block's coarse status. */
export function jobStatusFromGalaxyState(state: string | undefined): JobYaml["status"] {
  if (!state) return "in_progress";
  const s = state.toLowerCase();
  if (TERMINAL_OK.has(s)) return "completed";
  if (TERMINAL_BAD.has(s)) return "failed";
  return "in_progress";
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
  if (job.galaxyState) lines.push(`galaxy_state: ${job.galaxyState}`);
  if (job.lastPolledAt) lines.push(`last_polled_at: ${job.lastPolledAt}`);
  lines.push(JOB_FENCE_CLOSE);
  return lines.join("\n") + "\n";
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
    status: status === "completed" || status === "failed" ? status : "in_progress",
    summary: unescapeYaml(map.get("summary") ?? "") || undefined,
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
    if (lines[i].trim() === JOB_FENCE_OPEN) {
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
    if (lines[i].trim() === JOB_FENCE_OPEN) {
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
  const ranges = findJobBlockRanges(content);
  const lines = content.split("\n");
  const newBlock = renderJobYaml(job).trimEnd().split("\n");

  const existing = ranges.find((b) => b.jobId === job.jobId);
  if (existing) {
    const before = lines.slice(0, existing.start);
    const after = lines.slice(existing.end + 1);
    return [...before, ...newBlock, ...after].join("\n");
  }

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
  status: JobYaml["status"];
  galaxyState?: string;
  lastPolledAt: string;
  summary?: string;
}

/** Apply a poll result to whichever block carries that job id. No-op if absent. */
export function applyJobPollUpdate(content: string, update: JobPollUpdate): string {
  const current = findJobBlocks(content).find((j) => j.jobId === update.jobId);
  if (!current) return content;
  return upsertJobBlock(content, {
    ...current,
    status: update.status,
    galaxyState: update.galaxyState ?? current.galaxyState,
    lastPolledAt: update.lastPolledAt,
    summary: update.summary ?? current.summary,
  });
}
