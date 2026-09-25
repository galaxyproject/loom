/**
 * `loom-udt` notebook blocks: a pointer to a user-defined tool's definition.
 *
 * A UDT lives in Galaxy's database, scoped to the user who made it. That is
 * fine until the analysis outlives the account, the server, or the tool --
 * at which point the notebook says a tool ran and nothing says what it was.
 * So when the harness sees a UDT created, it writes the definition Galaxy
 * stored to `<analysis>/.loom/provenance/udt/<tool_id>.yaml` and drops this
 * block in the notebook pointing at it.
 *
 * Keyed on `tool_uuid`, which is what `run_user_tool` takes, so a run can be
 * traced back to the exact definition it used. Re-creating the same tool id
 * yields a new uuid and therefore a new block, which is correct: a redefined
 * tool is a different tool.
 *
 * ```loom-udt
 * tool_id: clean_table
 * tool_uuid: 8d5f1c2e-...
 * definition: .loom/provenance/udt/clean_table.yaml
 * created_at: 2026-09-16T15:30:00Z
 * notebook_anchor: plan-a-step-2
 * attempt_id: 01K5CJ6XWQ8QK4S2M7E9V0TZ3B
 * ```
 */

export interface UdtYaml {
  toolId: string;
  toolUuid: string;
  /** Repo-relative path to the stored definition. */
  definition: string;
  createdAt: string;
  notebookAnchor: string;
  attemptId?: string;
}

import { appendBlock, isUnambiguousRange } from "./notebook-writer";
import { scanFencedBlocks } from "./harness-block-fields";

const UDT_FENCE_OPEN = "```loom-udt";
const UDT_FENCE_CLOSE = "```";

function escapeYaml(value: string): string {
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

export function renderUdtYaml(udt: UdtYaml): string {
  const lines: string[] = [
    UDT_FENCE_OPEN,
    `tool_id: ${escapeYaml(udt.toolId)}`,
    `tool_uuid: ${escapeYaml(udt.toolUuid)}`,
    `definition: ${escapeYaml(udt.definition)}`,
    `created_at: ${udt.createdAt}`,
    `notebook_anchor: ${udt.notebookAnchor}`,
  ];
  if (udt.attemptId) lines.push(`attempt_id: ${udt.attemptId}`);
  lines.push(UDT_FENCE_CLOSE);
  return lines.join("\n") + "\n";
}

function parseUdtBlock(blockLines: string[]): UdtYaml | null {
  const map = new Map<string, string>();
  for (const line of blockLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const toolUuid = map.get("tool_uuid");
  const toolId = map.get("tool_id");
  const definition = map.get("definition");
  if (!toolUuid || !toolId || !definition) return null;
  return {
    toolId: unescapeYaml(toolId),
    toolUuid: unescapeYaml(toolUuid),
    definition: unescapeYaml(definition),
    createdAt: map.get("created_at") ?? "",
    notebookAnchor: map.get("notebook_anchor") ?? "",
    attemptId: map.get("attempt_id") || undefined,
  };
}

export function findUdtBlocks(content: string): UdtYaml[] {
  const lines = content.split("\n");
  const out: UdtYaml[] = [];
  for (const range of scanFencedBlocks(lines, UDT_FENCE_OPEN)) {
    const parsed = parseUdtBlock(lines.slice(range.start + 1, range.end));
    if (parsed) out.push(parsed);
  }
  return out;
}

/** True when a `loom-udt` block for this uuid is already in the notebook. */
export function hasUdtBlock(content: string, toolUuid: string): boolean {
  return findUdtBlocks(content).some((b) => b.toolUuid === toolUuid);
}

/** Upsert a `loom-udt` block keyed by `tool_uuid`. */
export function upsertUdtBlock(content: string, udt: UdtYaml): string {
  const lines = content.split("\n");
  const newBlock = renderUdtYaml(udt).trimEnd().split("\n");

  for (const range of scanFencedBlocks(lines, UDT_FENCE_OPEN)) {
    if (!isUnambiguousRange(lines, range.start)) continue;
    const parsed = parseUdtBlock(lines.slice(range.start + 1, range.end));
    if (parsed && parsed.toolUuid === udt.toolUuid) {
      return [...lines.slice(0, range.start), ...newBlock, ...lines.slice(range.end + 1)].join(
        "\n",
      );
    }
  }

  return appendBlock(content, newBlock);
}
