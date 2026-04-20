import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openIndexDb, SCHEMA_VERSION } from "../../extensions/loom/session-index/db";

describe("session-index db", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-index-db-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the schema on first open", () => {
    const db = openIndexDb(path.join(dir, "idx.db"));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["sessions", "entries", "tool_calls", "meta"]),
    );
    // FTS5 virtual table's shadow tables exist too
    expect(tables).toEqual(expect.arrayContaining(["entries_fts"]));
    db.close();
  });

  it("records and reads the schema version", () => {
    const db = openIndexDb(path.join(dir, "idx.db"));
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it("rebuilds cleanly if schema_version mismatches", () => {
    const p = path.join(dir, "idx.db");
    const db1 = openIndexDb(p);
    db1.prepare("INSERT INTO sessions(session_id, file_path, cwd, created_at, last_indexed_at, last_indexed_offset) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s1", "/tmp/f.jsonl", "/tmp", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", 0);
    db1.prepare("UPDATE meta SET value='0' WHERE key='schema_version'").run();
    db1.close();

    const db2 = openIndexDb(p);
    // Rebuild: prior row is gone
    const count = (db2.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    expect(count).toBe(0);
    db2.close();
  });
});
