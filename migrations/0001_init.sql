-- Knowledge baseline. App tables use the kn_ prefix (tb_* is SDK-reserved).

-- Memory areas. Scope instances of type "area" live in the SDK scope store; this table maps each
-- area to its engine resources. kind: agent (one per agent, "memory garden"), shared (company area).
CREATE TABLE kn_areas (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('agent', 'shared')),
  label         TEXT NOT NULL,
  agent_id      TEXT UNIQUE,
  source_id     TEXT NOT NULL UNIQUE,
  source_ready  INTEGER NOT NULL DEFAULT 0,
  notebook_id   TEXT UNIQUE,
  created_at    INTEGER NOT NULL,
  CHECK ((kind = 'agent') = (agent_id IS NOT NULL))
);

CREATE TABLE kn_collections (
  id          TEXT PRIMARY KEY,
  area_id     TEXT NOT NULL REFERENCES kn_areas(id),
  name        TEXT NOT NULL,
  description TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX kn_collections_area ON kn_collections(area_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX kn_collections_default ON kn_collections(area_id) WHERE is_default = 1;

CREATE TABLE kn_documents (
  id            TEXT PRIMARY KEY,
  area_id       TEXT NOT NULL REFERENCES kn_areas(id),
  collection_id TEXT NOT NULL REFERENCES kn_collections(id),
  parent_id     TEXT REFERENCES kn_documents(id),
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL,
  summary       TEXT,
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  tags          TEXT NOT NULL DEFAULT '[]',
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX kn_documents_area ON kn_documents(area_id, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX kn_documents_collection ON kn_documents(collection_id) WHERE deleted_at IS NULL;

CREATE TABLE kn_revisions (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kn_documents(id),
  version     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL,
  tags        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (document_id, version)
);

CREATE TABLE kn_comments (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kn_documents(id),
  parent_id   TEXT REFERENCES kn_comments(id),
  body        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX kn_comments_document ON kn_comments(document_id, created_at);

CREATE TABLE kn_links (
  id          TEXT PRIMARY KEY,
  area_id     TEXT NOT NULL REFERENCES kn_areas(id),
  source_id   TEXT NOT NULL REFERENCES kn_documents(id),
  target_id   TEXT NOT NULL REFERENCES kn_documents(id),
  type        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (source_id, target_id, type),
  CHECK (source_id <> target_id)
);
CREATE INDEX kn_links_target ON kn_links(target_id);

-- Keyword search (FTS5, external content = kn_documents; deleted documents are filtered at query time).
CREATE VIRTUAL TABLE kn_documents_fts USING fts5(title, summary, body, tags, content = 'kn_documents', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER kn_documents_ai AFTER INSERT ON kn_documents BEGIN
  INSERT INTO kn_documents_fts(rowid, title, summary, body, tags) VALUES (new.rowid, new.title, coalesce(new.summary, ''), new.body, new.tags);
END;
CREATE TRIGGER kn_documents_ad AFTER DELETE ON kn_documents BEGIN
  INSERT INTO kn_documents_fts(kn_documents_fts, rowid, title, summary, body, tags) VALUES ('delete', old.rowid, old.title, coalesce(old.summary, ''), old.body, old.tags);
END;
CREATE TRIGGER kn_documents_au AFTER UPDATE OF title, summary, body, tags ON kn_documents BEGIN
  INSERT INTO kn_documents_fts(kn_documents_fts, rowid, title, summary, body, tags) VALUES ('delete', old.rowid, old.title, coalesce(old.summary, ''), old.body, old.tags);
  INSERT INTO kn_documents_fts(rowid, title, summary, body, tags) VALUES (new.rowid, new.title, coalesce(new.summary, ''), new.body, new.tags);
END;

-- Projection outbox: one row per (area, document), written in the same transaction as the canonical change.
CREATE TABLE kn_projection (
  area_id         TEXT NOT NULL,
  document_id     TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  content_hash    TEXT,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (area_id, document_id)
);
CREATE INDEX kn_projection_due ON kn_projection(state, next_attempt_at);

-- Engine OAuth clients registered through the GBrain admin API (private network only).
CREATE TABLE kn_gbrain_clients (
  key           TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  principal     TEXT
);

-- Small app state (e.g. the research chat model id provisioned in Open Notebook).
CREATE TABLE kn_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
