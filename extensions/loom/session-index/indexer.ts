import type { Database as Db } from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSessionFile, type EntryRow, type ToolCallRow } from "./parse";
import { decodeCwd } from "./cwd";

export interface ScanReport {
  sessionsSeen: number;
  sessionsRemoved: number;
  entriesInserted: number;
  toolCallsInserted: number;
}

/**
 * Default location of Pi's session corpus.
 */
export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

/**
 * Incrementally synchronize the index DB against a sessions directory.
 *
 * Safe to call repeatedly. On the first call, indexes every file in bulk.
 * Subsequent calls resume per-file from the stored byte offset; files
 * whose mtime hasn't advanced are skipped. Sessions whose file has been
 * deleted are removed from the index.
 */
export function scanSessions(db: Db, sessionsDir: string = defaultSessionsDir()): ScanReport {
  const report: ScanReport = {
    sessionsSeen: 0,
    sessionsRemoved: 0,
    entriesInserted: 0,
    toolCallsInserted: 0,
  };

  if (!fs.existsSync(sessionsDir)) return report;

  const knownFiles = listJsonlFiles(sessionsDir);
  const seenPaths = new Set(knownFiles);

  // Stale-session cleanup (ON DELETE CASCADE handles entries + tool_calls)
  const existing = db.prepare("SELECT session_id, file_path FROM sessions").all() as Array<{
    session_id: string;
    file_path: string;
  }>;
  const del = db.prepare("DELETE FROM sessions WHERE session_id = ?");
  for (const row of existing) {
    if (!seenPaths.has(row.file_path)) {
      del.run(row.session_id);
      report.sessionsRemoved++;
    }
  }

  const selState = db.prepare(
    "SELECT session_id, last_indexed_offset FROM sessions WHERE file_path = ?",
  );
  const upsertSession = db.prepare(`
    INSERT INTO sessions(
      session_id, file_path, cwd, name, parent_session, notebook_path,
      created_at, last_indexed_at, last_indexed_offset
    )
    VALUES (@session_id, @file_path, @cwd, @name, @parent_session, @notebook_path,
            @created_at, @last_indexed_at, @last_indexed_offset)
    ON CONFLICT(session_id) DO UPDATE SET
      name            = COALESCE(excluded.name, sessions.name),
      notebook_path   = COALESCE(excluded.notebook_path, sessions.notebook_path),
      last_indexed_at = excluded.last_indexed_at,
      last_indexed_offset = excluded.last_indexed_offset
  `);
  const insEntry = db.prepare(`
    INSERT OR IGNORE INTO entries(
      entry_id, session_id, parent_id, entry_type, timestamp, role, text_content, raw_json
    ) VALUES (@entry_id, @session_id, @parent_id, @entry_type, @timestamp, @role, @text_content, @raw_json)
  `);
  const insTc = db.prepare(`
    INSERT OR IGNORE INTO tool_calls(entry_id, session_id, tool_use_id, tool_name, arguments_json, result_text)
    VALUES (@entry_id, @session_id, @tool_use_id, @tool_name, @arguments_json, @result_text)
  `);

  const indexOne = db.transaction((filePath: string) => {
    const prior = selState.get(filePath) as
      | { session_id: string; last_indexed_offset: number }
      | undefined;
    const startOffset = prior?.last_indexed_offset ?? 0;
    const fileSize = fs.statSync(filePath).size;
    if (prior && startOffset >= fileSize) return;

    const parsed = parseSessionFile(filePath, {
      startOffset,
      skipHeader: startOffset > 0,
    });

    // Decode cwd from directory name (fallback to header.cwd when decode fails)
    const enclosingDir = path.basename(path.dirname(filePath));
    const cwd = decodeCwd(enclosingDir) ?? parsed.header.cwd ?? "";

    const sessionId = prior?.session_id ?? parsed.header.id;
    if (!sessionId) return;

    upsertSession.run({
      session_id: sessionId,
      file_path: filePath,
      cwd,
      name: parsed.sessionName,
      parent_session: parsed.header.parentSession,
      notebook_path: parsed.notebookPath,
      created_at: parsed.header.createdAt || new Date().toISOString(),
      last_indexed_at: new Date().toISOString(),
      last_indexed_offset: parsed.endOffset,
    });

    for (const entry of parsed.entries) {
      const info = insEntry.run({
        ...entry,
        session_id: sessionId,
      } as EntryRow & { session_id: string });
      if (info.changes > 0) report.entriesInserted++;
    }
    for (const tc of parsed.tool_calls) {
      const info = insTc.run({
        ...tc,
        session_id: sessionId,
      } as ToolCallRow & { session_id: string });
      if (info.changes > 0) report.toolCallsInserted++;
    }

    report.sessionsSeen++;
  });

  for (const fp of knownFiles) {
    try {
      indexOne(fp);
    } catch {
      // Broken file -- skip, don't halt the scan
    }
  }

  return report;
}

function listJsonlFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(root, entry.name);
    for (const file of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (!file.name.endsWith(".jsonl")) continue;
      out.push(path.join(sub, file.name));
    }
  }
  return out;
}
