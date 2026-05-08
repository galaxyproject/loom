import fs from "node:fs";

export interface SessionHeader {
  id: string;
  cwd: string;
  createdAt: string;
  parentSession: string | null;
}

export interface EntryRow {
  entry_id: string;
  parent_id: string | null;
  entry_type: string;
  timestamp: string;
  role: "user" | "assistant" | null;
  text_content: string | null;
  raw_json: string;
}

export interface ToolCallRow {
  entry_id: string;
  tool_use_id: string;
  tool_name: string;
  arguments_json: string;
  result_text: string | null;
}

export interface ParseResult {
  header: SessionHeader;
  entries: EntryRow[];
  tool_calls: ToolCallRow[];
  /** Latest customType=galaxy_analyst_plan entry's data.notebookPath, if any. */
  notebookPath: string | null;
  /** Latest customType=session_info name, if any. */
  sessionName: string | null;
  /**
   * Byte offset (exclusive) of the last newline-terminated line parsed.
   * Trailing bytes after the last newline are not consumed -- the next
   * scan will re-read them, so a torn read while Pi is actively writing
   * doesn't silently drop the partial line.
   */
  endOffset: number;
}

export interface ParseOptions {
  /** Start parsing from this byte offset (used for incremental scans). */
  startOffset?: number;
  /** Skip emitting the header if we're resuming past it. */
  skipHeader?: boolean;
}

/**
 * Parse a Pi session JSONL file into normalized rows for the index.
 *
 * Does NOT throw on malformed lines; invalid JSON lines are skipped and
 * the caller's endOffset still advances past them (so incremental scans
 * don't loop on a corrupt line).
 */
export function parseSessionFile(filePath: string, opts: ParseOptions = {}): ParseResult {
  const startOffset = opts.startOffset ?? 0;
  const buf = fs.readFileSync(filePath);
  const slice = buf.subarray(startOffset);
  const text = slice.toString("utf8");

  const entries: EntryRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const pendingResults = new Map<string, string>();
  let header: SessionHeader | null = null;
  let notebookPath: string | null = null;
  let sessionName: string | null = null;

  let lineStart = 0;
  let lastCompleteLineEnd = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10 /* \n */) continue;
    const raw = text.slice(lineStart, i);
    lineStart = i + 1;
    lastCompleteLineEnd = i + 1;
    if (raw.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }

    if (obj.type === "session") {
      if (!opts.skipHeader) {
        header = {
          id: String(obj.id ?? ""),
          cwd: String(obj.cwd ?? ""),
          createdAt: String(obj.timestamp ?? ""),
          parentSession: typeof obj.parentSession === "string" ? obj.parentSession : null,
        };
      }
      continue;
    }

    const row = entryRowFromObj(obj);
    if (!row) continue;
    entries.push(row);

    if (row.entry_type === "message" && row.role === "assistant") {
      for (const tc of extractToolUses(obj)) {
        toolCalls.push({ entry_id: row.entry_id, ...tc });
      }
    }
    if (row.entry_type === "message" && row.role === "user") {
      for (const { tool_use_id, text_content } of extractToolResults(obj)) {
        pendingResults.set(tool_use_id, text_content);
      }
    }

    if (row.entry_type === "custom") {
      const customType = String((obj as { customType?: unknown }).customType ?? "");
      if (customType === "galaxy_analyst_plan") {
        const data = (obj as { data?: { notebookPath?: string } }).data;
        if (data?.notebookPath) notebookPath = data.notebookPath;
      }
    }
    if (row.entry_type === "session_info") {
      const name = (obj as { name?: string }).name;
      if (name) sessionName = name;
    }
  }

  // Join tool-call results by tool_use_id (now a first-class field).
  const byUseId = new Map<string, ToolCallRow>();
  for (const tc of toolCalls) {
    byUseId.set(tc.tool_use_id, tc);
  }
  for (const [useId, text] of pendingResults) {
    const target = byUseId.get(useId);
    if (target) target.result_text = text;
  }

  if (!header && !opts.skipHeader) {
    throw new Error(`No session header found in ${filePath}`);
  }

  return {
    header: header ?? ({ id: "", cwd: "", createdAt: "", parentSession: null } as SessionHeader),
    entries,
    tool_calls: toolCalls,
    notebookPath,
    sessionName,
    endOffset: startOffset + Buffer.byteLength(text.slice(0, lastCompleteLineEnd), "utf8"),
  };
}

function entryRowFromObj(obj: Record<string, unknown>): EntryRow | null {
  const type = typeof obj.type === "string" ? obj.type : "";
  const entryId = typeof obj.id === "string" ? obj.id : null;
  if (!type || !entryId) return null;

  const parentId = typeof obj.parentId === "string" ? obj.parentId : null;
  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";

  let role: "user" | "assistant" | null = null;
  let text: string | null = null;
  if (type === "message") {
    const msg = (obj as { message?: { role?: string; content?: unknown } }).message;
    const r = msg?.role;
    if (r === "user" || r === "assistant") role = r;
    text = flattenTextBlocks(msg?.content);
  } else if (type === "compaction") {
    text =
      typeof (obj as { summary?: string }).summary === "string"
        ? (obj as { summary: string }).summary
        : null;
  } else if (type === "branch_summary") {
    text =
      typeof (obj as { summary?: string }).summary === "string"
        ? (obj as { summary: string }).summary
        : null;
  } else if (type === "custom") {
    text = JSON.stringify((obj as { data?: unknown }).data ?? null);
  }

  return {
    entry_id: entryId,
    parent_id: parentId,
    entry_type: type,
    timestamp,
    role,
    text_content: text,
    raw_json: JSON.stringify(obj),
  };
}

function flattenTextBlocks(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractToolUses(
  obj: Record<string, unknown>,
): Array<{ tool_use_id: string; tool_name: string; arguments_json: string; result_text: null }> {
  const content = (obj as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{
    tool_use_id: string;
    tool_name: string;
    arguments_json: string;
    result_text: null;
  }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; name?: string; input?: unknown; id?: string };
    if (b.type !== "tool_use" || typeof b.name !== "string") continue;
    const tool_use_id =
      typeof b.id === "string" && b.id.length > 0 ? b.id : `synth-${b.name}-${out.length}`;
    out.push({
      tool_use_id,
      tool_name: b.name,
      arguments_json: JSON.stringify(b.input ?? {}),
      result_text: null,
    });
  }
  return out;
}

function extractToolResults(
  obj: Record<string, unknown>,
): Array<{ tool_use_id: string; text_content: string }> {
  const content = (obj as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ tool_use_id: string; text_content: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as {
      type?: string;
      tool_use_id?: string;
      content?: unknown;
    };
    if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
    out.push({
      tool_use_id: b.tool_use_id,
      text_content: flattenTextBlocks(b.content) ?? "",
    });
  }
  return out;
}
