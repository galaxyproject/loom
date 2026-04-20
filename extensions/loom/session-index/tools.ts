import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { openIndexDb, defaultDbPath } from "./db";
import { scanSessions } from "./indexer";
import {
  searchChat,
  getSessionContext,
  findToolCalls,
} from "./query";

export function registerSessionIndexTools(pi: ExtensionAPI): void {
  // Long-lived DB handle for the lifetime of the extension. The session-index
  // DB assumes a single writer per user (see db.ts) -- opening once here and
  // keeping the WAL/shm files live for the process is the intended shape.
  const db = openIndexDb(defaultDbPath());

  // Dedup refreshes inside a burst of tool calls. Pi routes a model's tool
  // round-trips through us in quick succession; re-scanning every time would
  // triple-stat the corpus for no added freshness.
  const REFRESH_WINDOW_MS = 2_000;
  let lastScanAt = 0;
  function refresh(): void {
    const now = Date.now();
    if (now - lastScanAt < REFRESH_WINDOW_MS) return;
    lastScanAt = now;
    try {
      scanSessions(db);
    } catch {
      // Don't fail a tool call because of a broken scan; return whatever's indexed.
    }
  }

  pi.registerTool({
    name: "chat_search",
    label: "Search prior sessions",
    description:
      "Full-text search across every Pi session you've had in this account. " +
      "Searches message text only -- for tool-call arguments use chat_find_tool_calls. " +
      "Default scope is 'all' (every project). Use scope='cwd' to restrict to the " +
      "current analysis directory. Returns ranked hits with a snippet; follow up " +
      "with chat_session_context to read surrounding turns.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "FTS5 query (porter-stemmed tokens)." }),
      scope: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("cwd")], {
          description: "Which sessions to search. Default: 'all'.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Max hits. Default 20." }),
      ),
    }),
    async execute(_id, params) {
      refresh();
      try {
        const hits = searchChat(db, {
          query: params.query,
          scope: params.scope ?? "all",
          cwd: process.cwd(),
          limit: params.limit,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(hits, null, 2) }],
          details: { count: hits.length, error: undefined as string | undefined },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: msg, hint: "Check FTS5 query syntax (e.g. quoting)." }, null, 2),
          }],
          details: { count: 0, error: msg as string | undefined },
        };
      }
    },
    renderResult: (result) => {
      const d = result.details as { count?: number; error?: string } | undefined;
      if (d?.error) return new Text(`⚠️  ${d.error}`);
      return new Text(`🔎 ${d?.count ?? 0} hits`);
    },
  });

  pi.registerTool({
    name: "chat_session_context",
    label: "Read surrounding turns",
    description:
      "Given an entry_id (from chat_search or chat_find_tool_calls), return a " +
      "window of N entries before and after it from the same session. Default " +
      "window is 3 before + 3 after. Entries above a compaction point are " +
      "still retrievable (the index keeps everything the JSONL keeps).",
    parameters: Type.Object({
      entry_id: Type.String({ minLength: 1 }),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, default: 3 })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, default: 3 })),
    }),
    async execute(_id, params) {
      refresh();
      const rows = getSessionContext(db, {
        entry_id: params.entry_id,
        before: params.before,
        after: params.after,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
        details: { count: rows.length },
      };
    },
    renderResult: (result) => {
      const d = result.details as { count?: number } | undefined;
      return new Text(`📜 ${d?.count ?? 0} entries`);
    },
  });

  pi.registerTool({
    name: "chat_find_tool_calls",
    label: "Find prior tool calls",
    description:
      "Structured search over prior tool invocations. Pass tool_name to filter " +
      "(e.g. 'workflow_set_overrides'); optional args_contains does a substring " +
      "match on the arguments JSON (underscore and percent are escaped to avoid " +
      "LIKE wildcard surprises). Returns parsed arguments and a truncated " +
      "result summary per hit.",
    parameters: Type.Object({
      tool_name: Type.String({ minLength: 1 }),
      args_contains: Type.Optional(Type.String({ minLength: 1 })),
      scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("cwd")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params) {
      refresh();
      const calls = findToolCalls(db, {
        tool_name: params.tool_name,
        args_contains: params.args_contains,
        scope: params.scope ?? "all",
        cwd: process.cwd(),
        limit: params.limit,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(calls, null, 2) }],
        details: { count: calls.length, tool: params.tool_name },
      };
    },
    renderResult: (result) => {
      const d = result.details as { count?: number; tool?: string } | undefined;
      return new Text(`🛠 ${d?.count ?? 0} ${d?.tool ?? ""} calls`);
    },
  });
}
