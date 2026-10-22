-- Shared schema for the "web" and "mcp" Workers (one D1 database).
CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE packs (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  summary     TEXT NOT NULL DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  validation  TEXT,                         -- verdict from the validation LLM
  r2_key      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- External-content FTS5 index, kept in sync by triggers (same shape as spike/mcp-worker).
CREATE VIRTUAL TABLE packs_fts USING fts5(
  name, summary, content='packs', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER packs_ai AFTER INSERT ON packs BEGIN
  INSERT INTO packs_fts(rowid, name, summary) VALUES (new.id, new.name, new.summary);
END;
CREATE TRIGGER packs_ad AFTER DELETE ON packs BEGIN
  INSERT INTO packs_fts(packs_fts, rowid, name, summary) VALUES ('delete', old.id, old.name, old.summary);
END;
CREATE TRIGGER packs_au AFTER UPDATE ON packs BEGIN
  INSERT INTO packs_fts(packs_fts, rowid, name, summary) VALUES ('delete', old.id, old.name, old.summary);
  INSERT INTO packs_fts(rowid, name, summary) VALUES (new.id, new.name, new.summary);
END;
