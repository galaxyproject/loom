import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openIndexDb } from "../../extensions/loom/session-index/db";
import { scanSessions } from "../../extensions/loom/session-index/indexer";
import { encodeCwd } from "../../extensions/loom/session-index/cwd";

const BASIC = `\
{"type":"session","version":3,"id":"sess-basic","timestamp":"2026-04-01T10:00:00Z","cwd":"/tmp/proj"}
{"type":"message","id":"e1","parentId":null,"timestamp":"2026-04-01T10:00:05Z","message":{"role":"user","content":[{"type":"text","text":"hello fixture"}]}}
{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-04-01T10:00:10Z","message":{"role":"assistant","content":[{"type":"text","text":"hi! this is the assistant reply"}]}}
`;

const APPENDED = `\
{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-04-01T10:00:15Z","message":{"role":"user","content":[{"type":"text","text":"follow up please"}]}}
`;

function makeSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-index-scan-"));
  const cwdDir = path.join(dir, encodeCwd("/tmp/proj"));
  fs.mkdirSync(cwdDir, { recursive: true });
  fs.writeFileSync(path.join(cwdDir, "sess-basic.jsonl"), BASIC);
  return dir;
}

describe("scanSessions", () => {
  let sessionsDir: string;
  let dbPath: string;

  beforeEach(() => {
    sessionsDir = makeSessionsDir();
    dbPath = path.join(sessionsDir, "idx.db");
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("bulk indexes an untouched corpus", () => {
    const db = openIndexDb(dbPath);
    const report = scanSessions(db, sessionsDir);
    expect(report.sessionsSeen).toBe(1);
    expect(report.entriesInserted).toBe(2);

    const entries = db
      .prepare("SELECT entry_id, role, text_content FROM entries ORDER BY timestamp")
      .all() as Array<{
      entry_id: string;
      role: string | null;
      text_content: string | null;
    }>;
    expect(entries.map((e) => e.entry_id)).toEqual(["e1", "e2"]);
    db.close();
  });

  it("incrementally appends new entries without re-inserting", () => {
    const db = openIndexDb(dbPath);
    scanSessions(db, sessionsDir);

    const fp = path.join(sessionsDir, encodeCwd("/tmp/proj"), "sess-basic.jsonl");
    fs.appendFileSync(fp, APPENDED);

    const report2 = scanSessions(db, sessionsDir);
    expect(report2.entriesInserted).toBe(1);

    const count = (db.prepare("SELECT COUNT(*) as n FROM entries").get() as { n: number }).n;
    expect(count).toBe(3);
    db.close();
  });

  it("drops rows for sessions whose file has been deleted", () => {
    const db = openIndexDb(dbPath);
    scanSessions(db, sessionsDir);
    const fp = path.join(sessionsDir, encodeCwd("/tmp/proj"), "sess-basic.jsonl");
    fs.rmSync(fp);

    const report = scanSessions(db, sessionsDir);
    expect(report.sessionsRemoved).toBe(1);
    const count = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    expect(count).toBe(0);
    db.close();
  });

  it("populates notebook_path from galaxy_analyst_plan custom entries", () => {
    const fp = path.join(sessionsDir, encodeCwd("/tmp/proj"), "sess-basic.jsonl");
    fs.appendFileSync(
      fp,
      `{"type":"custom","id":"ec","parentId":"e2","timestamp":"2026-04-01T10:00:20Z","customType":"galaxy_analyst_plan","data":{"notebookPath":"/tmp/proj/notebook.md"}}\n`,
    );
    const db = openIndexDb(dbPath);
    scanSessions(db, sessionsDir);
    const row = db
      .prepare("SELECT notebook_path FROM sessions WHERE session_id='sess-basic'")
      .get() as { notebook_path: string | null };
    expect(row.notebook_path).toBe("/tmp/proj/notebook.md");
    db.close();
  });

  it("indexes parallel tool_use calls to the same tool without collapsing", () => {
    const fp = path.join(sessionsDir, encodeCwd("/tmp/proj"), "sess-basic.jsonl");
    // Append an assistant message with TWO tool_use blocks for the same tool name.
    fs.appendFileSync(
      fp,
      `{"type":"message","id":"par","parentId":"e2","timestamp":"2026-04-01T10:00:30Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tuA","name":"workflow_set_overrides","input":{"stepId":"ism","overrides":{"variant_ism_width":600}}},{"type":"tool_use","id":"tuB","name":"workflow_set_overrides","input":{"stepId":"ism","overrides":{"ism_scanner":{"max_region_width":600}}}}]}}\n`,
    );
    const db = openIndexDb(dbPath);
    scanSessions(db, sessionsDir);
    const rows = db
      .prepare("SELECT tool_use_id, arguments_json FROM tool_calls WHERE entry_id = 'par'")
      .all() as Array<{ tool_use_id: string; arguments_json: string }>;
    expect(rows).toHaveLength(2);
    const useIds = rows.map((r) => r.tool_use_id).sort();
    expect(useIds).toEqual(["tuA", "tuB"]);
    db.close();
  });

  it("does not index a partial line written without a trailing newline", () => {
    const fp = path.join(sessionsDir, encodeCwd("/tmp/proj"), "sess-basic.jsonl");
    // Simulate Pi mid-write: append a partial message line with NO trailing newline
    fs.appendFileSync(
      fp,
      '{"type":"message","id":"partial","parentId":"e2","timestamp":"2026-04-01T10:00:12Z","message":{"role":"assistant","content":[{"type":"text","text":"half-writ',
    );

    const db = openIndexDb(dbPath);
    const r1 = scanSessions(db, sessionsDir);
    // Only the 2 complete lines from the original BASIC fixture get indexed
    expect(r1.entriesInserted).toBe(2);
    const mid = db.prepare("SELECT entry_id FROM entries WHERE entry_id = 'partial'").get();
    expect(mid).toBeUndefined();

    // Pi finishes the line (completes the JSON object and adds the newline)
    fs.appendFileSync(fp, 'ten"}]}}\n');

    const r2 = scanSessions(db, sessionsDir);
    expect(r2.entriesInserted).toBe(1);
    const row = db.prepare("SELECT entry_id FROM entries WHERE entry_id = 'partial'").get() as
      | { entry_id?: string }
      | undefined;
    expect(row?.entry_id).toBe("partial");
    db.close();
  });
});
