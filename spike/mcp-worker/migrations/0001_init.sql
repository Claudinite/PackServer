-- Packs registry core table (spike-sized).
CREATE TABLE packs (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,          -- e.g. @google/gcp-basics
  version     TEXT NOT NULL,
  category    TEXT NOT NULL,                 -- e.g. cloud, devops, data
  summary     TEXT NOT NULL,
  description TEXT NOT NULL,
  keywords    TEXT NOT NULL DEFAULT '',      -- space separated
  features    TEXT NOT NULL DEFAULT '{}',    -- JSON: counts of skills/prompts/checks/tasks
  repo_url    TEXT,                          -- NULL => no public repo
  r2_key      TEXT NOT NULL,                 -- object key in the PACKS bucket
  stars       INTEGER NOT NULL DEFAULT 0,
  visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX packs_category_idx ON packs(category);

-- External-content FTS5 index over packs; kept in sync by triggers.
CREATE VIRTUAL TABLE packs_fts USING fts5(
  name, summary, description, keywords,
  content='packs', content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER packs_ai AFTER INSERT ON packs BEGIN
  INSERT INTO packs_fts(rowid, name, summary, description, keywords)
  VALUES (new.id, new.name, new.summary, new.description, new.keywords);
END;
CREATE TRIGGER packs_ad AFTER DELETE ON packs BEGIN
  INSERT INTO packs_fts(packs_fts, rowid, name, summary, description, keywords)
  VALUES ('delete', old.id, old.name, old.summary, old.description, old.keywords);
END;
CREATE TRIGGER packs_au AFTER UPDATE ON packs BEGIN
  INSERT INTO packs_fts(packs_fts, rowid, name, summary, description, keywords)
  VALUES ('delete', old.id, old.name, old.summary, old.description, old.keywords);
  INSERT INTO packs_fts(rowid, name, summary, description, keywords)
  VALUES (new.id, new.name, new.summary, new.description, new.keywords);
END;
