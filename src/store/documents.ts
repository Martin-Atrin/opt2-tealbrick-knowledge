// Canonical, engine-independent document store (collections, documents, revisions, comments, links).
// Authorization happens in the handlers (SDK scope access per area); this module enforces data integrity:
// parents in the same collection without cycles, links inside one area, optimistic concurrency, soft delete.
// Every change to a document writes its projection outbox row in the same transaction.
import { createHash } from "node:crypto";
import type { Db } from "@opt2-tealbrick/spec/sdk";
import { newId, slugify } from "../ids.ts";

export type DocumentStatus = "draft" | "published" | "archived";

export interface Collection {
  id: string;
  area: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Document {
  id: string;
  area: string;
  collectionId: string;
  parentId: string | null;
  title: string;
  slug: string;
  summary: string | null;
  body: string;
  status: DocumentStatus;
  tags: string[];
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export class StoreError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const notFound = (what: string) => new StoreError(`${what}_not_found`, `${what} not found`, 404);

type Row = Record<string, unknown>;
const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => Number(value);

function toCollection(row: Row): Collection {
  return {
    id: String(row.id),
    area: String(row.area_id),
    name: String(row.name),
    description: str(row.description),
    isDefault: num(row.is_default) === 1,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toDocument(row: Row): Document {
  return {
    id: String(row.id),
    area: String(row.area_id),
    collectionId: String(row.collection_id),
    parentId: str(row.parent_id),
    title: String(row.title),
    slug: String(row.slug),
    summary: str(row.summary),
    body: String(row.body),
    status: String(row.status) as DocumentStatus,
    tags: JSON.parse(String(row.tags)) as string[],
    version: num(row.version),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function cleanTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

/** Markdown page projected into the memory engine (identity = document id, never the title). */
export function documentMarkdown(doc: Document): string {
  const q = (value: string) => JSON.stringify(value);
  return [
    "---",
    "type: knowledge_document",
    `knowledge_document_id: ${q(doc.id)}`,
    `area: ${q(doc.area)}`,
    `collection_id: ${q(doc.collectionId)}`,
    `status: ${q(doc.status)}`,
    `title: ${q(doc.title)}`,
    `tags: ${JSON.stringify(doc.tags)}`,
    "---",
    "",
    `# ${doc.title}`,
    "",
    ...(doc.summary ? [doc.summary, ""] : []),
    doc.body,
  ].join("\n");
}

export const contentHash = (markdown: string) => createHash("sha256").update(markdown).digest("hex");

/** FTS5 query from free text: every token quoted (no operator injection), OR-joined, prefix match on the last token. */
export function ftsQuery(text: string): string | null {
  const tokens = text.normalize("NFKC").match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
  if (!tokens.length) return null;
  return tokens.map((token, i) => (i === tokens.length - 1 && token.length >= 3 ? `"${token}"*` : `"${token}"`)).join(" OR ");
}

export interface SearchHit {
  id: string;
  area: string;
  collectionId: string;
  title: string;
  summary: string | null;
  excerpt: string;
  status: DocumentStatus;
  tags: string[];
  updatedAt: number;
  rank: number;
}

export class DocumentStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  // ── collections ──

  ensureDefaultCollection(area: string, actor: string): Collection {
    const existing = this.db.prepare("SELECT * FROM kn_collections WHERE area_id = ? AND is_default = 1").get(area);
    if (existing) return toCollection(existing);
    const at = this.now();
    const id = newId("kcol");
    this.db
      .prepare("INSERT INTO kn_collections (id, area_id, name, description, is_default, created_by, created_at, updated_at) VALUES (?, ?, 'Memories', NULL, 1, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(id, area, actor, at, at);
    return toCollection(this.db.prepare("SELECT * FROM kn_collections WHERE area_id = ? AND is_default = 1").get(area) as Row);
  }

  createCollection(area: string, name: string, description: string | undefined, actor: string): Collection {
    const at = this.now();
    const id = newId("kcol");
    this.db
      .prepare("INSERT INTO kn_collections (id, area_id, name, description, is_default, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
      .run(id, area, name.trim(), description?.trim() || null, actor, at, at);
    return this.getCollection(id) as Collection;
  }

  getCollection(id: string): Collection | null {
    const row = this.db.prepare("SELECT * FROM kn_collections WHERE id = ? AND deleted_at IS NULL").get(id);
    return row ? toCollection(row) : null;
  }

  listCollections(area: string): (Collection & { documentCount: number })[] {
    return this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM kn_documents d WHERE d.collection_id = c.id AND d.deleted_at IS NULL) AS document_count
         FROM kn_collections c WHERE c.area_id = ? AND c.deleted_at IS NULL ORDER BY c.is_default DESC, c.name`,
      )
      .all(area)
      .map((row) => ({ ...toCollection(row), documentCount: num(row.document_count) }));
  }

  // ── documents ──

  getDocument(id: string): Document | null {
    const row = this.db.prepare("SELECT * FROM kn_documents WHERE id = ? AND deleted_at IS NULL").get(id);
    return row ? toDocument(row) : null;
  }

  createDocument(input: {
    area: string;
    collectionId?: string;
    parentId?: string;
    title: string;
    body?: string;
    summary?: string;
    status?: DocumentStatus;
    tags?: string[];
    actor: string;
  }): Document {
    const title = input.title.trim();
    if (!title) throw new StoreError("title_required", "title must not be empty", 400);
    return this.db.transaction(() => {
      const collection = input.collectionId ? this.getCollection(input.collectionId) : this.ensureDefaultCollection(input.area, input.actor);
      // A collection in another area answers like a missing one (no existence leak).
      if (!collection || collection.area !== input.area) throw notFound("collection");
      if (input.parentId) {
        const parent = this.getDocument(input.parentId);
        if (!parent || parent.collectionId !== collection.id) throw new StoreError("parent_invalid", "parent must be a document in the same collection", 400);
      }
      const at = this.now();
      const id = newId("kdoc");
      const tags = JSON.stringify(cleanTags(input.tags));
      const summary = input.summary?.trim() || null;
      const body = input.body ?? "";
      const status = input.status ?? "draft";
      this.db
        .prepare(
          `INSERT INTO kn_documents (id, area_id, collection_id, parent_id, title, slug, summary, body, status, tags, version, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(id, input.area, collection.id, input.parentId ?? null, title, slugify(title), summary, body, status, tags, input.actor, input.actor, at, at);
      this.writeRevision(id, 1, title, summary, body, status, tags, input.actor, at);
      this.db.prepare("UPDATE kn_collections SET updated_at = ? WHERE id = ?").run(at, collection.id);
      const doc = this.getDocument(id) as Document;
      this.enqueue(doc.area, doc.id, "upsert");
      return doc;
    });
  }

  updateDocument(
    id: string,
    patch: { title?: string; body?: string; summary?: string; status?: DocumentStatus; tags?: string[] },
    expectedVersion: number | undefined,
    actor: string,
  ): Document {
    return this.db.transaction(() => {
      const current = this.getDocument(id);
      if (!current) throw notFound("document");
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw new StoreError("version_conflict", `document is at version ${current.version}`, 409);
      }
      const title = patch.title?.trim() || current.title;
      const summary = patch.summary === undefined ? current.summary : patch.summary.trim() || null;
      const body = patch.body ?? current.body;
      const status = patch.status ?? current.status;
      const tagList = patch.tags === undefined ? current.tags : cleanTags(patch.tags);
      const unchanged =
        title === current.title && summary === current.summary && body === current.body && status === current.status && JSON.stringify(tagList) === JSON.stringify(current.tags);
      if (unchanged) return current;
      const at = this.now();
      const version = current.version + 1;
      const tags = JSON.stringify(tagList);
      this.db
        .prepare("UPDATE kn_documents SET title = ?, slug = ?, summary = ?, body = ?, status = ?, tags = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?")
        .run(title, slugify(title), summary, body, status, tags, version, actor, at, id, current.version);
      this.writeRevision(id, version, title, summary, body, status, tags, actor, at);
      const doc = this.getDocument(id) as Document;
      this.enqueue(doc.area, doc.id, "upsert");
      return doc;
    });
  }

  deleteDocument(id: string, actor: string): void {
    this.db.transaction(() => {
      const current = this.getDocument(id);
      if (!current) throw notFound("document");
      const at = this.now();
      // Children move up to the deleted document's parent; links touching it disappear.
      this.db.prepare("UPDATE kn_documents SET parent_id = ? WHERE parent_id = ? AND deleted_at IS NULL").run(current.parentId, id);
      this.db.prepare("DELETE FROM kn_links WHERE source_id = ? OR target_id = ?").run(id, id);
      this.db.prepare("UPDATE kn_documents SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(at, actor, at, id);
      this.enqueue(current.area, id, "delete");
    });
  }

  revisions(id: string, limit = 20): { version: number; title: string; summary: string | null; createdBy: string; createdAt: number }[] {
    return this.db
      .prepare("SELECT version, title, summary, created_by, created_at FROM kn_revisions WHERE document_id = ? ORDER BY version DESC LIMIT ?")
      .all(id, Math.min(Math.max(limit, 1), 100))
      .map((row) => ({ version: num(row.version), title: String(row.title), summary: str(row.summary), createdBy: String(row.created_by), createdAt: num(row.created_at) }));
  }

  private writeRevision(documentId: string, version: number, title: string, summary: string | null, body: string, status: string, tags: string, actor: string, at: number) {
    this.db
      .prepare("INSERT INTO kn_revisions (id, document_id, version, title, summary, body, status, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId("krev"), documentId, version, title, summary, body, status, tags, actor, at);
  }

  // ── comments ──

  addComment(documentId: string, body: string, parentId: string | undefined, actor: string): { id: string } {
    const text = body.trim();
    if (!text) throw new StoreError("body_required", "comment must not be empty", 400);
    if (!this.getDocument(documentId)) throw notFound("document");
    if (parentId) {
      const parent = this.db.prepare("SELECT document_id FROM kn_comments WHERE id = ?").get(parentId);
      if (!parent || parent.document_id !== documentId) throw new StoreError("parent_invalid", "reply target must be a comment on the same document", 400);
    }
    const id = newId("kcom");
    this.db.prepare("INSERT INTO kn_comments (id, document_id, parent_id, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, documentId, parentId ?? null, text, actor, this.now());
    return { id };
  }

  listComments(documentId: string): { id: string; parentId: string | null; body: string; createdBy: string; createdAt: number }[] {
    return this.db
      .prepare("SELECT * FROM kn_comments WHERE document_id = ? ORDER BY created_at, id")
      .all(documentId)
      .map((row) => ({ id: String(row.id), parentId: str(row.parent_id), body: String(row.body), createdBy: String(row.created_by), createdAt: num(row.created_at) }));
  }

  // ── links ──

  addLink(sourceId: string, targetId: string, type: string, actor: string): { id: string } {
    if (sourceId === targetId) throw new StoreError("link_invalid", "a document cannot link to itself", 400);
    const source = this.getDocument(sourceId);
    const target = this.getDocument(targetId);
    if (!source) throw notFound("document");
    // A target in another area answers like a missing one.
    if (!target || target.area !== source.area) throw notFound("link_target");
    const existing = this.db.prepare("SELECT id FROM kn_links WHERE source_id = ? AND target_id = ? AND type = ?").get(sourceId, targetId, type);
    if (existing) return { id: String(existing.id) };
    const id = newId("klnk");
    this.db.prepare("INSERT INTO kn_links (id, area_id, source_id, target_id, type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, source.area, sourceId, targetId, type, actor, this.now());
    return { id };
  }

  listLinks(documentId: string): { outbound: Row[]; backlinks: Row[] } {
    const map = (row: Row) => ({ id: String(row.id), type: String(row.type), documentId: String(row.doc_id), title: String(row.title), updatedAt: num(row.updated_at) });
    const outbound = this.db
      .prepare("SELECT l.id, l.type, d.id AS doc_id, d.title, d.updated_at FROM kn_links l JOIN kn_documents d ON d.id = l.target_id AND d.deleted_at IS NULL WHERE l.source_id = ? ORDER BY l.created_at")
      .all(documentId)
      .map(map);
    const backlinks = this.db
      .prepare("SELECT l.id, l.type, d.id AS doc_id, d.title, d.updated_at FROM kn_links l JOIN kn_documents d ON d.id = l.source_id AND d.deleted_at IS NULL WHERE l.target_id = ? ORDER BY l.created_at")
      .all(documentId)
      .map(map);
    return { outbound, backlinks };
  }

  // ── search ──

  search(input: { areas: readonly string[]; query?: string; collectionId?: string; limit?: number }): SearchHit[] {
    if (!input.areas.length) return [];
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const marks = input.areas.map(() => "?").join(", ");
    const collectionFilter = input.collectionId ? " AND d.collection_id = ?" : "";
    const params: unknown[] = [...input.areas, ...(input.collectionId ? [input.collectionId] : [])];
    const match = input.query ? ftsQuery(input.query) : null;
    const hit = (row: Row): SearchHit => ({
      id: String(row.id),
      area: String(row.area_id),
      collectionId: String(row.collection_id),
      title: String(row.title),
      summary: str(row.summary),
      excerpt: String(row.excerpt),
      status: String(row.status) as DocumentStatus,
      tags: JSON.parse(String(row.tags)) as string[],
      updatedAt: num(row.updated_at),
      rank: num(row.rank),
    });
    if (!match) {
      return this.db
        .prepare(
          `SELECT d.*, substr(d.body, 1, 240) AS excerpt, 0 AS rank FROM kn_documents d
           WHERE d.deleted_at IS NULL AND d.area_id IN (${marks})${collectionFilter} ORDER BY d.updated_at DESC LIMIT ?`,
        )
        .all(...params, limit)
        .map(hit);
    }
    return this.db
      .prepare(
        `SELECT d.*, snippet(kn_documents_fts, 2, '', '', ' … ', 24) AS excerpt, bm25(kn_documents_fts, 8.0, 4.0, 1.0, 2.0) AS rank
         FROM kn_documents_fts JOIN kn_documents d ON d.rowid = kn_documents_fts.rowid
         WHERE kn_documents_fts MATCH ? AND d.deleted_at IS NULL AND d.area_id IN (${marks})${collectionFilter}
         ORDER BY rank LIMIT ?`,
      )
      .all(match, ...params, limit)
      .map(hit);
  }

  // ── projection outbox ──

  private enqueue(area: string, documentId: string, action: "upsert" | "delete") {
    this.db
      .prepare(
        `INSERT INTO kn_projection (area_id, document_id, action, content_hash, state, attempts, next_attempt_at, last_error, updated_at)
         VALUES (?, ?, ?, NULL, 'pending', 0, 0, NULL, ?)
         ON CONFLICT (area_id, document_id) DO UPDATE SET action = excluded.action, state = 'pending', attempts = 0, next_attempt_at = 0, last_error = NULL, updated_at = max(excluded.updated_at, kn_projection.updated_at + 1)`,
      )
      .run(area, documentId, action, this.now());
  }
}
