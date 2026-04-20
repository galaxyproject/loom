/** Bump this whenever a migration would be needed. openIndexDb() responds
 * by dropping the existing DB and rebuilding from scratch -- the source of
 * truth is the Pi JSONLs, so this is cheap and safe.
 */
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE sessions (
  session_id          TEXT PRIMARY KEY,
  file_path           TEXT NOT NULL UNIQUE,
  cwd                 TEXT NOT NULL,
  name                TEXT,
  parent_session      TEXT,
  notebook_path       TEXT,
  created_at          TEXT NOT NULL,
  last_indexed_at     TEXT NOT NULL,
  last_indexed_offset INTEGER NOT NULL
);
CREATE INDEX sessions_cwd ON sessions(cwd);

CREATE TABLE entries (
  entry_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  parent_id    TEXT,
  entry_type   TEXT NOT NULL,
  timestamp    TEXT NOT NULL,
  role         TEXT,
  text_content TEXT,
  raw_json     TEXT NOT NULL
);
CREATE INDEX entries_session ON entries(session_id, timestamp);
CREATE INDEX entries_type    ON entries(entry_type);

CREATE TABLE tool_calls (
  entry_id       TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_use_id    TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  result_text    TEXT,
  PRIMARY KEY (entry_id, tool_use_id)
);
CREATE INDEX tool_calls_name ON tool_calls(tool_name);

CREATE VIRTUAL TABLE entries_fts USING fts5(
  text_content,
  content='entries',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Keep FTS in sync with entries
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, text_content)
  VALUES (new.rowid, coalesce(new.text_content, ''));
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, text_content)
  VALUES ('delete', old.rowid, coalesce(old.text_content, ''));
END;
CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, text_content)
  VALUES ('delete', old.rowid, coalesce(old.text_content, ''));
  INSERT INTO entries_fts(rowid, text_content)
  VALUES (new.rowid, coalesce(new.text_content, ''));
END;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
