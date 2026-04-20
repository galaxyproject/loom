import type { Database as Db } from "better-sqlite3";

export interface SearchHit {
  entry_id: string;
  session_id: string;
  session_name: string | null;
  cwd: string;
  notebook_path: string | null;
  timestamp: string;
  role: "user" | "assistant" | null;
  snippet: string;
}

export interface ContextRow {
  entry_id: string;
  role: "user" | "assistant" | null;
  entry_type: string;
  timestamp: string;
  text: string;
}

export interface ToolCallHit {
  entry_id: string;
  session_id: string;
  cwd: string;
  notebook_path: string | null;
  timestamp: string;
  arguments: unknown;
  result_summary: string | null;
}

export interface SearchParams {
  query: string;
  scope?: "all" | "cwd";
  cwd?: string;
  limit?: number;
}

export interface ContextParams {
  entry_id: string;
  before?: number;
  after?: number;
}

export interface ToolCallParams {
  tool_name: string;
  args_contains?: string;
  scope?: "all" | "cwd";
  cwd?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(n?: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

export function searchChat(db: Db, params: SearchParams): SearchHit[] {
  const limit = clampLimit(params.limit);
  const scopeCwd = params.scope === "cwd" && params.cwd;
  const scopeClause = scopeCwd ? "AND s.cwd = @cwd" : "";

  const rows = db
    .prepare(
      `
      SELECT
        e.entry_id,
        e.session_id,
        s.name          AS session_name,
        s.cwd,
        s.notebook_path,
        e.timestamp,
        e.role,
        snippet(entries_fts, 0, '[', ']', '…', 20) AS snippet
      FROM entries_fts
      JOIN entries e ON e.rowid = entries_fts.rowid
      JOIN sessions s ON s.session_id = e.session_id
      WHERE entries_fts MATCH @query
        ${scopeClause}
      ORDER BY e.timestamp DESC
      LIMIT @limit
      `,
    )
    .all({ query: params.query, cwd: params.cwd ?? "", limit }) as SearchHit[];

  return rows;
}

export function getSessionContext(db: Db, params: ContextParams): ContextRow[] {
  const before = Math.max(0, params.before ?? 3);
  const after = Math.max(0, params.after ?? 3);

  const anchor = db
    .prepare("SELECT session_id, timestamp FROM entries WHERE entry_id = ?")
    .get(params.entry_id) as { session_id: string; timestamp: string } | undefined;
  if (!anchor) return [];

  const beforeRows = db
    .prepare(
      `
      SELECT entry_id, role, entry_type, timestamp, COALESCE(text_content, '') AS text
      FROM entries
      WHERE session_id = @sid AND (timestamp, entry_id) < (@ts, @eid)
      ORDER BY timestamp DESC, entry_id DESC
      LIMIT @n
      `,
    )
    .all({ sid: anchor.session_id, ts: anchor.timestamp, eid: params.entry_id, n: before }) as ContextRow[];

  const anchorRow = db
    .prepare(
      `
      SELECT entry_id, role, entry_type, timestamp, COALESCE(text_content, '') AS text
      FROM entries WHERE entry_id = ?
      `,
    )
    .get(params.entry_id) as ContextRow;

  const afterRows = db
    .prepare(
      `
      SELECT entry_id, role, entry_type, timestamp, COALESCE(text_content, '') AS text
      FROM entries
      WHERE session_id = @sid AND (timestamp, entry_id) > (@ts, @eid)
      ORDER BY timestamp ASC, entry_id ASC
      LIMIT @n
      `,
    )
    .all({ sid: anchor.session_id, ts: anchor.timestamp, eid: params.entry_id, n: after }) as ContextRow[];

  return [...beforeRows.reverse(), anchorRow, ...afterRows];
}

export function findToolCalls(db: Db, params: ToolCallParams): ToolCallHit[] {
  const limit = clampLimit(params.limit);
  const scopeCwd = params.scope === "cwd" && params.cwd;
  const scopeClause = scopeCwd ? "AND s.cwd = @cwd" : "";
  const argsClause = params.args_contains
    ? "AND tc.arguments_json LIKE @args ESCAPE '\\'"
    : "";

  const bindParams: Record<string, unknown> = { tool: params.tool_name, limit };
  if (params.args_contains) bindParams.args = `%${escapeLike(params.args_contains)}%`;
  if (scopeCwd) bindParams.cwd = params.cwd;

  const rows = db
    .prepare(
      `
      SELECT
        tc.entry_id,
        tc.session_id,
        s.cwd,
        s.notebook_path,
        e.timestamp,
        tc.arguments_json,
        tc.result_text
      FROM tool_calls tc
      JOIN entries  e ON e.entry_id  = tc.entry_id
      JOIN sessions s ON s.session_id = tc.session_id
      WHERE tc.tool_name = @tool
        ${argsClause}
        ${scopeClause}
      ORDER BY e.timestamp DESC
      LIMIT @limit
      `,
    )
    .all(bindParams) as Array<{
      entry_id: string;
      session_id: string;
      cwd: string;
      notebook_path: string | null;
      timestamp: string;
      arguments_json: string;
      result_text: string | null;
    }>;

  return rows.map(r => ({
    entry_id: r.entry_id,
    session_id: r.session_id,
    cwd: r.cwd,
    notebook_path: r.notebook_path,
    timestamp: r.timestamp,
    arguments: safeJson(r.arguments_json),
    result_summary: r.result_text ? r.result_text.slice(0, 500) : null,
  }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}
