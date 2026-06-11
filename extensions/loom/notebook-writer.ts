/**
 * Notebook file I/O.
 *
 * The notebook is plain user/agent-curated markdown. This module provides
 * file-system helpers and string-level utilities for the one structured
 * thing inside a notebook: `loom-invocation` fenced YAML blocks that the
 * Galaxy invocation polling tools read and write.
 */

import * as fs from "fs/promises";
import * as path from "path";

/**
 * Generate slug from title for default filename.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Per-path mutex chain. Two parallel `upsertInvocationBlock` calls (e.g.
 * `galaxy_invocation_check_all` polling several invocations concurrently)
 * would race read-modify-write on the same notebook file: each reads the
 * pre-update content, applies its block, and the second writer overwrites
 * the first. Serializing via a per-path Promise chain prevents the lost
 * update without paying for an OS-level lock.
 */
const writeLocks = new Map<string, Promise<void>>();

export function withNotebookLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(filePath) ?? Promise.resolve();
  const next = prev.then(work, work);
  // Always clear so completed locks don't pin memory; the chain is preserved
  // through the Promise we just created.
  writeLocks.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Atomic notebook write: render to `<file>.tmp` then rename. The rename
 * is atomic on POSIX, so the destination either has the old or the new
 * content — never partial. The file watcher in state.ts may still fire
 * on the rename, but it can no longer observe a half-written file.
 */
export async function writeNotebook(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  // O_TRUNC | O_WRONLY | O_CREAT via fs.writeFile — but write to tmp first.
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, filePath);
}

/**
 * Read notebook from file.
 */
export async function readNotebook(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8");
}

/**
 * Check if a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List notebook files in a directory. Each session dir has exactly one
 * fixed-name file, `notebook.md`. We still return an array so callers
 * that iterate stay working.
 */
export async function listNotebooks(directory: string): Promise<string[]> {
  const fixed = path.join(directory, "notebook.md");
  try {
    await fs.access(fixed);
    return [fixed];
  } catch {
    return [];
  }
}

/**
 * Default notebook path for a session directory. `title` is kept in the
 * signature for API stability but is no longer used — every session dir
 * stores its notebook as `notebook.md`.
 */
export function getDefaultNotebookPath(_title: string, directory: string): string {
  return path.join(directory, "notebook.md");
}

// ─────────────────────────────────────────────────────────────────────────────
// Invocation YAML blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured Galaxy invocation record embedded in the notebook as a
 * `loom-invocation` fenced YAML block. The block format is intentionally
 * line-oriented and grep-friendly:
 *
 * ```loom-invocation
 * invocation_id: abc123
 * galaxy_server_url: https://usegalaxy.org
 * notebook_anchor: plan-1-step-3
 * label: BWA alignment
 * submitted_at: 2026-04-25T15:30:00Z
 * status: in_progress
 * summary: ""
 * ```
 *
 * Status transitions (`in_progress` → `completed`/`failed`) are written by
 * the invocation polling tools (see tools.ts). The block is the source of
 * truth — there's no in-memory cache.
 */
export interface InvocationYaml {
  invocationId: string;
  galaxyServerUrl: string;
  notebookAnchor: string;
  label: string;
  submittedAt: string;
  status: "in_progress" | "completed" | "failed";
  summary?: string;
  // Progress counters — populated by galaxy_invocation_check_*. Persisted
  // back to the YAML so the Orbit renderer can draw a live progress bar
  // without each side polling Galaxy independently. Optional so older
  // blocks (and the initial record-time write) round-trip cleanly.
  totalSteps?: number;
  completedSteps?: number;
  totalJobs?: number;
  completedJobs?: number;
  failedJobs?: number;
  lastPolledAt?: string;
}

const INVOCATION_FENCE_OPEN = "```loom-invocation";
const INVOCATION_FENCE_CLOSE = "```";

/**
 * Render an invocation as a `loom-invocation` fenced block. The trailing
 * newline is intentional so blocks can be appended cleanly.
 */
export function renderInvocationYaml(inv: InvocationYaml): string {
  const lines: string[] = [
    INVOCATION_FENCE_OPEN,
    `invocation_id: ${inv.invocationId}`,
    `galaxy_server_url: ${inv.galaxyServerUrl}`,
    `notebook_anchor: ${inv.notebookAnchor}`,
    `label: ${escapeYaml(inv.label)}`,
    `submitted_at: ${inv.submittedAt}`,
    `status: ${inv.status}`,
    `summary: ${escapeYaml(inv.summary ?? "")}`,
  ];
  if (inv.totalSteps !== undefined) lines.push(`total_steps: ${inv.totalSteps}`);
  if (inv.completedSteps !== undefined) lines.push(`completed_steps: ${inv.completedSteps}`);
  if (inv.totalJobs !== undefined) lines.push(`total_jobs: ${inv.totalJobs}`);
  if (inv.completedJobs !== undefined) lines.push(`completed_jobs: ${inv.completedJobs}`);
  if (inv.failedJobs !== undefined) lines.push(`failed_jobs: ${inv.failedJobs}`);
  if (inv.lastPolledAt) lines.push(`last_polled_at: ${inv.lastPolledAt}`);
  lines.push(INVOCATION_FENCE_CLOSE);
  return lines.join("\n") + "\n";
}

/**
 * Find every `loom-invocation` block in the notebook content and parse
 * each into an InvocationYaml. Skips blocks that fail validation.
 */
export function findInvocationBlocks(content: string): InvocationYaml[] {
  const result: InvocationYaml[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === INVOCATION_FENCE_OPEN) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== INVOCATION_FENCE_CLOSE) {
        end++;
      }
      const blockLines = lines.slice(start, end);
      const parsed = parseInvocationBlock(blockLines);
      if (parsed) result.push(parsed);
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

/**
 * Upsert a `loom-invocation` block in the notebook content keyed by
 * `invocation_id`. If a block with the same id exists, replace it in
 * place (preserving surrounding whitespace). Otherwise append at the
 * end of the file with a leading blank line for readability.
 */
export function upsertInvocationBlock(content: string, inv: InvocationYaml): string {
  const blocks = findInvocationBlockRanges(content);
  const lines = content.split("\n");
  const newBlock = renderInvocationYaml(inv).trimEnd().split("\n");

  const existing = blocks.find((b) => b.invocationId === inv.invocationId);
  if (existing) {
    const before = lines.slice(0, existing.start);
    const after = lines.slice(existing.end + 1);
    return [...before, ...newBlock, ...after].join("\n");
  }

  // Append at end with separator
  const trimmed = content.replace(/\s+$/, "");
  const sep = trimmed.length > 0 ? "\n\n" : "";
  return trimmed + sep + newBlock.join("\n") + "\n";
}

interface InvocationBlockRange {
  invocationId: string;
  start: number;
  end: number;
}

function findInvocationBlockRanges(content: string): InvocationBlockRange[] {
  const result: InvocationBlockRange[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === INVOCATION_FENCE_OPEN) {
      const start = i;
      let end = start + 1;
      let invocationId: string | null = null;
      while (end < lines.length && lines[end].trim() !== INVOCATION_FENCE_CLOSE) {
        const m = lines[end].match(/^invocation_id:\s*(.+)$/);
        if (m) invocationId = m[1].trim();
        end++;
      }
      if (invocationId) {
        result.push({ invocationId, start, end });
      }
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

function parseInvocationBlock(blockLines: string[]): InvocationYaml | null {
  const fields: Record<string, string> = {};
  for (const line of blockLines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = unescapeYaml(m[2].trim());
  }
  const status = fields.status as InvocationYaml["status"];
  if (
    !fields.invocation_id ||
    !fields.galaxy_server_url ||
    !fields.notebook_anchor ||
    !fields.label ||
    !fields.submitted_at ||
    (status !== "in_progress" && status !== "completed" && status !== "failed")
  ) {
    return null;
  }
  const numField = (key: string): number | undefined => {
    const raw = fields[key];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    invocationId: fields.invocation_id,
    galaxyServerUrl: fields.galaxy_server_url,
    notebookAnchor: fields.notebook_anchor,
    label: fields.label,
    submittedAt: fields.submitted_at,
    status,
    summary: fields.summary || undefined,
    totalSteps: numField("total_steps"),
    completedSteps: numField("completed_steps"),
    totalJobs: numField("total_jobs"),
    completedJobs: numField("completed_jobs"),
    failedJobs: numField("failed_jobs"),
    lastPolledAt: fields.last_polled_at || undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session summary YAML blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `loom-session` block, appended on `session_shutdown`. Pairs with the
 * notebook's role as the durable record: when a Pi session dies mid-poll,
 * a fresh session can read the most recent `loom-session` block to learn
 * what was in flight and re-orient. `orphaned_active_steps` is 0 today
 * (typed plan-step blocks don't exist yet); the field is here so the
 * schema stays stable when that follow-up lands.
 */
export interface SessionSummaryYaml {
  id: string;
  startedAt: string;
  endedAt: string;
  notebook: string;
  orphanedActiveSteps: number;
}

const SESSION_FENCE_OPEN = "```loom-session";
const SESSION_FENCE_CLOSE = "```";

export function renderSessionSummaryYaml(s: SessionSummaryYaml): string {
  const lines: string[] = [
    SESSION_FENCE_OPEN,
    `id: ${s.id}`,
    `started_at: ${s.startedAt}`,
    `ended_at: ${s.endedAt}`,
    `notebook: ${s.notebook}`,
    `orphaned_active_steps: ${s.orphanedActiveSteps}`,
    SESSION_FENCE_CLOSE,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Append a session summary block at the end of the notebook content. This is
 * the low-level primitive used for a session id never seen before; callers
 * that finalize a session should use `upsertSessionSummaryBlock`, which keys
 * on `id` and routes here only for first-seen ids.
 */
export function appendSessionSummaryBlock(content: string, s: SessionSummaryYaml): string {
  const block = renderSessionSummaryYaml(s).trimEnd();
  const trimmed = content.replace(/\s+$/, "");
  const sep = trimmed.length > 0 ? "\n\n" : "";
  return trimmed + sep + block + "\n";
}

/**
 * Upsert a `loom-session` block keyed by `id`. A first-seen id appends a new
 * block (chronological log of distinct sessions); a seen id collapses every
 * block sharing that id, plus the new finalize, into a single merged block
 * that spans the session id's full lifetime.
 *
 * Why upsert and not append (#260): Pi can hand back the *same* session id
 * when an idle session is resumed, so a blind append wrote two blocks under
 * one id and broke the id's role as a unique key. Collapsing keeps exactly
 * one block per id -- and self-heals a notebook the old append path already
 * left with duplicates.
 *
 * The merged block keeps the position of the id's first block, so blocks stay
 * in first-seen order. That order can diverge from strict `ended_at` order if
 * a non-latest session is resumed; no consumer relies on positional recency
 * today, and keeping the slot avoids reshuffling the user's notebook.
 */
export function upsertSessionSummaryBlock(content: string, s: SessionSummaryYaml): string {
  const matching = findSessionSummaryBlockRanges(content).filter((r) => r.summary.id === s.id);
  if (matching.length === 0) {
    return appendSessionSummaryBlock(content, s);
  }
  const merged = matching.reduce((acc, r) => mergeSessionSummary(acc, r.summary), s);
  const newBlock = renderSessionSummaryYaml(merged).trimEnd().split("\n");
  const drop = new Set<number>();
  for (const r of matching) {
    for (let li = r.start; li <= r.end; li++) drop.add(li);
  }
  const insertAt = matching[0].start;
  const lines = content.split("\n");
  const rebuilt: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    if (li === insertAt) rebuilt.push(...newBlock);
    if (drop.has(li)) continue;
    rebuilt.push(lines[li]);
  }
  return rebuilt.join("\n");
}

/**
 * Merge finalizes of the same session id into one record. Keep the earliest
 * start and the latest end so the block spans the whole lifetime across
 * resumes; carry the orphan count from whichever finalize ended later (the
 * authoritative end state).
 */
function mergeSessionSummary(
  prev: SessionSummaryYaml,
  next: SessionSummaryYaml,
): SessionSummaryYaml {
  const nextEndsLater = compareTimestamps(next.endedAt, prev.endedAt) >= 0;
  return {
    id: next.id,
    startedAt:
      compareTimestamps(next.startedAt, prev.startedAt) < 0 ? next.startedAt : prev.startedAt,
    endedAt: nextEndsLater ? next.endedAt : prev.endedAt,
    notebook: next.notebook,
    orphanedActiveSteps: nextEndsLater ? next.orphanedActiveSteps : prev.orphanedActiveSteps,
  };
}

// Order two timestamps. The shutdown writer always emits valid ISO-8601 UTC,
// which Date.parse compares correctly (including across offsets). Fall back to
// a lexical compare only if a hand-edited value won't parse, so the result is
// still deterministic rather than NaN-poisoned.
function compareTimestamps(a: string, b: string): number {
  const na = Date.parse(a);
  const nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface SessionSummaryBlockRange {
  summary: SessionSummaryYaml;
  start: number;
  end: number;
}

function findSessionSummaryBlockRanges(content: string): SessionSummaryBlockRange[] {
  const result: SessionSummaryBlockRange[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === SESSION_FENCE_OPEN) {
      const start = i;
      let end = start + 1;
      while (end < lines.length && lines[end].trim() !== SESSION_FENCE_CLOSE) {
        end++;
      }
      const summary = parseSessionSummaryBlock(lines.slice(start + 1, end));
      if (summary) result.push({ summary, start, end });
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

/**
 * Find every `loom-session` block in the notebook content and parse each.
 * Skips blocks that fail validation. Used by `session_start` to surface
 * any orphaned-active state from the previous session.
 */
export function findSessionSummaryBlocks(content: string): SessionSummaryYaml[] {
  const result: SessionSummaryYaml[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === SESSION_FENCE_OPEN) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== SESSION_FENCE_CLOSE) {
        end++;
      }
      const parsed = parseSessionSummaryBlock(lines.slice(start, end));
      if (parsed) result.push(parsed);
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

function parseSessionSummaryBlock(blockLines: string[]): SessionSummaryYaml | null {
  const fields: Record<string, string> = {};
  for (const line of blockLines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = unescapeYaml(m[2].trim());
  }
  if (!fields.id || !fields.started_at || !fields.ended_at || !fields.notebook) {
    return null;
  }
  const orphaned = Number(fields.orphaned_active_steps);
  return {
    id: fields.id,
    startedAt: fields.started_at,
    endedAt: fields.ended_at,
    notebook: fields.notebook,
    orphanedActiveSteps: Number.isFinite(orphaned) ? orphaned : 0,
  };
}

function escapeYaml(value: string): string {
  // Quote if contains characters that would confuse the line parser.
  if (/[:#\n]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function unescapeYaml(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}
