import Database, { type Database as Db } from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export { SCHEMA_VERSION };

/**
 * Open (and if needed rebuild) the session-index database.
 *
 * The index is a derived cache -- Pi's JSONL files are the source of truth --
 * so a schema-version mismatch triggers a clean rebuild rather than a
 * migration. Cheap because the next scan will repopulate.
 */
export function openIndexDb(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const existing = isSchemaCurrent(db);
  if (!existing) {
    // Single-writer assumption: the session-index DB has one owner per user.
    // If a second process opens between close() and the rmSync calls, its
    // handle becomes invalid -- accepted tradeoff for a derived-cache layer.
    db.close();
    fs.rmSync(filePath, { force: true });
    fs.rmSync(filePath + "-wal", { force: true });
    fs.rmSync(filePath + "-shm", { force: true });
    db = new Database(filePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  }
  return db;
}

function isSchemaCurrent(db: Db): boolean {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    return row?.value === String(SCHEMA_VERSION);
  } catch {
    // meta table doesn't exist yet
    return false;
  }
}

/** Default location: ~/.loom/sessions-index.db. */
export function defaultDbPath(): string {
  return path.join(os.homedir(), ".loom", "sessions-index.db");
}
