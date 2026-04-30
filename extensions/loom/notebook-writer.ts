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
    INVOCATION_FENCE_CLOSE,
  ];
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
  return {
    invocationId: fields.invocation_id,
    galaxyServerUrl: fields.galaxy_server_url,
    notebookAnchor: fields.notebook_anchor,
    label: fields.label,
    submittedAt: fields.submitted_at,
    status,
    summary: fields.summary || undefined,
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
