/**
 * `loom-galaxy-page` fenced YAML block — the durable record of a notebook's
 * binding to a Galaxy page (see galaxyproject/galaxy#22361, Galaxy Notebooks).
 *
 * Lives inside notebook.md alongside the existing `loom-invocation` blocks
 * documented in notebook-writer.ts. Same render / find / upsert grammar,
 * keyed on `page_id`. Today's MVP uses one block per notebook, but the
 * keyed-upsert contract supports N-per-notebook for future per-plan
 * bindings.
 *
 * Block shape:
 *
 * ```loom-galaxy-page
 * page_id: abc123
 * page_slug: my-analysis
 * galaxy_server_url: "https://usegalaxy.org"
 * history_id: hist456
 * last_synced_revision: rev789
 * bound_at: 2026-05-14T11:00:00Z
 * ```
 *
 * v1 sync semantics — IMPORTANT, document expectations here so future readers
 * don't have to spelunk through tool code:
 *
 *   - `push` is **unconditional local-wins**. The local notebook content
 *     replaces the Galaxy page body. Concurrent edits on the Galaxy UI side
 *     are silently discarded.
 *   - `pull` is **unconditional remote-wins**. The Galaxy page body replaces
 *     the local notebook content. Local edits since the last sync are lost
 *     except for typed blocks (loom-galaxy-page itself, loom-invocation),
 *     which the pull flow re-applies on top of the remote body.
 *   - `last_synced_revision` is stored and refreshed after every successful
 *     push/pull so v2 can add a pre-flight concurrency check without a data
 *     migration. It is **not** enforced today.
 *
 * Galaxy Pages are not the primary edit surface and the agent is the only
 * push caller, so concurrent UI edits during an active session are an edge
 * case rather than the norm. v2 will revisit once we have real usage data.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Type
// ─────────────────────────────────────────────────────────────────────────────

export interface GalaxyPageBindingYaml {
  pageId: string;
  pageSlug: string | null;
  galaxyServerUrl: string;
  historyId: string;
  lastSyncedRevision: string | null;
  boundAt: string;
}

const BINDING_FENCE_OPEN = "```loom-galaxy-page";
const BINDING_FENCE_CLOSE = "```";

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a binding as a `loom-galaxy-page` fenced block. The trailing
 * newline is intentional so blocks can be appended cleanly.
 */
export function renderGalaxyPageBlock(binding: GalaxyPageBindingYaml): string {
  const lines: string[] = [
    BINDING_FENCE_OPEN,
    `page_id: ${binding.pageId}`,
    `page_slug: ${binding.pageSlug ?? ""}`,
    `galaxy_server_url: ${escapeYaml(binding.galaxyServerUrl)}`,
    `history_id: ${binding.historyId}`,
    `last_synced_revision: ${binding.lastSyncedRevision ?? ""}`,
    `bound_at: ${binding.boundAt}`,
    BINDING_FENCE_CLOSE,
  ];
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Find
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find every `loom-galaxy-page` block in the notebook content and parse
 * each into a GalaxyPageBindingYaml. Skips blocks that fail validation
 * (missing required fields).
 */
export function findGalaxyPageBlocks(content: string): GalaxyPageBindingYaml[] {
  const result: GalaxyPageBindingYaml[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === BINDING_FENCE_OPEN) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== BINDING_FENCE_CLOSE) {
        end++;
      }
      const parsed = parseGalaxyPageBlock(lines.slice(start, end));
      if (parsed) result.push(parsed);
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upsert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a `loom-galaxy-page` block keyed by `page_id`. Replaces in place
 * if a block with the same page id exists; otherwise appends at the end
 * of the file with a leading blank line.
 */
export function upsertGalaxyPageBlock(
  content: string,
  binding: GalaxyPageBindingYaml,
): string {
  const ranges = findGalaxyPageBlockRanges(content);
  const lines = content.split("\n");
  const newBlock = renderGalaxyPageBlock(binding).trimEnd().split("\n");

  const existing = ranges.find((r) => r.pageId === binding.pageId);
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
 * Remove every `loom-galaxy-page` block from the content. Used on push so
 * Galaxy doesn't render Loom's internal binding metadata, and defensively
 * on pull in case the remote echoed it back.
 */
export function stripGalaxyPageBlocks(content: string): string {
  const ranges = findGalaxyPageBlockRanges(content);
  if (ranges.length === 0) return content;

  const lines = content.split("\n");
  const drop = new Set<number>();
  for (const r of ranges) {
    for (let n = r.start; n <= r.end; n++) drop.add(n);
    // Also drop a single trailing blank line so consecutive strips don't
    // leave wide gaps in the output.
    if (r.end + 1 < lines.length && lines[r.end + 1].trim() === "") {
      drop.add(r.end + 1);
    }
  }
  return lines.filter((_, idx) => !drop.has(idx)).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

interface GalaxyPageBlockRange {
  pageId: string;
  start: number;
  end: number;
}

function findGalaxyPageBlockRanges(content: string): GalaxyPageBlockRange[] {
  const result: GalaxyPageBlockRange[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === BINDING_FENCE_OPEN) {
      const start = i;
      let end = start + 1;
      let pageId: string | null = null;
      while (end < lines.length && lines[end].trim() !== BINDING_FENCE_CLOSE) {
        const m = lines[end].match(/^page_id:\s*(.+)$/);
        if (m) pageId = m[1].trim();
        end++;
      }
      if (pageId) {
        result.push({ pageId, start, end });
      }
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

function parseGalaxyPageBlock(blockLines: string[]): GalaxyPageBindingYaml | null {
  const fields: Record<string, string> = {};
  for (const line of blockLines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = unescapeYaml(m[2].trim());
  }
  if (!fields.page_id || !fields.galaxy_server_url || !fields.history_id || !fields.bound_at) {
    return null;
  }
  return {
    pageId: fields.page_id,
    pageSlug: fields.page_slug || null,
    galaxyServerUrl: fields.galaxy_server_url,
    historyId: fields.history_id,
    lastSyncedRevision: fields.last_synced_revision || null,
    boundAt: fields.bound_at,
  };
}

function escapeYaml(value: string): string {
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
