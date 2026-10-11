// GBrain adapter: maps an authorized area to its engine source and translates operations.
// Authorization never moves into the engine; callers pass only areas the SDK already allowed.
import type { DynamicCatalogEntry } from "@opt2-tealbrick/spec/manifest";
import type { GBrainClient } from "./client.ts";
import { GBrainServiceError } from "./client.ts";
import { catalogEntries, resolveEntry } from "./exposure.ts";
import { argumentRefusal } from "./guard.ts";
import { neutralizeFenceMarkers, sanitizeResult } from "./privacy.ts";
import { GBrainError } from "./transport.ts";

export const PAGE_PREFIX = "knowledge-docs/";

export interface RecallRow {
  area: string;
  documentId: string | null;
  slug: string;
  title: string;
  text: string;
  score: number | null;
}

export class EngineCallError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const ERROR_STATUS: Record<string, number> = {
  invalid_params: 400,
  permission_denied: 403,
  scope_denied: 403,
  page_not_found: 404,
  revision_conflict: 409,
  rate_limited: 429,
  embedding_failed: 502,
  extraction_failed: 502,
  operation_failed: 502,
  unavailable: 503,
};

/** Map engine failures to the CORE §8 envelope; transport failures stay thrown (a write may have executed). */
export function engineError(error: unknown): EngineCallError {
  if (error instanceof EngineCallError) return error;
  if (error instanceof GBrainServiceError) {
    return error.code === "area_binding_required"
      ? new EngineCallError("area_not_ready", "the memory area is still being prepared in the engine", 503)
      : new EngineCallError("engine_unavailable", "the memory engine is not reachable", 503);
  }
  if (error instanceof GBrainError && error.kind === "tool") {
    const code = error.code ?? "operation_failed";
    return new EngineCallError(`engine_${code}`, error.message, ERROR_STATUS[code] ?? 502);
  }
  return new EngineCallError("engine_unavailable", "the memory engine did not answer", 503);
}

function findRows(data: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4 || data === null || typeof data !== "object") return [];
  if (Array.isArray(data)) {
    const rows = data.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item));
    if (rows.some((row) => typeof row.slug === "string" || typeof row.chunk_text === "string" || typeof row.text === "string")) return rows;
    return [];
  }
  const record = data as Record<string, unknown>;
  for (const key of ["results", "hits", "evidence", "items", "chunks", "pages"]) {
    const rows = findRows(record[key], depth + 1);
    if (rows.length) return rows;
  }
  return [];
}

export class GBrainEngine {
  readonly id = "gbrain";
  private readonly client: GBrainClient;
  /** source of an area the catalog may read schemas from (the shared area always exists) */
  private readonly catalogSource: string;

  constructor(client: GBrainClient, catalogSource: string) {
    this.client = client;
    this.catalogSource = catalogSource;
  }

  health() {
    return this.client.health();
  }

  async projectDocument(sourceId: string, documentId: string, markdown: string): Promise<void> {
    await this.client.putCanonicalPage(sourceId, `${PAGE_PREFIX}${documentId}`, neutralizeFenceMarkers(markdown));
  }

  async removeDocument(sourceId: string, documentId: string): Promise<void> {
    await this.client.deleteCanonicalPage(sourceId, `${PAGE_PREFIX}${documentId}`);
  }

  /** Hybrid search in one area's source; rows normalized and sanitized. */
  async recall(area: string, sourceId: string, query: string, limit: number, principalId: string): Promise<RecallRow[]> {
    const data = sanitizeResult(await this.client.call(sourceId, "query", { query, limit }, { principalId, timeoutMs: 120_000 }), sourceId);
    return findRows(data)
      .slice(0, limit)
      .map((row) => {
        const slug = typeof row.slug === "string" ? row.slug : "";
        return {
          area,
          documentId: slug.startsWith(PAGE_PREFIX) ? slug.slice(PAGE_PREFIX.length) : null,
          slug,
          title: typeof row.title === "string" ? row.title : slug,
          text: String(row.chunk_text ?? row.text ?? row.snippet ?? "").slice(0, 4000),
          score: typeof row.score === "number" ? row.score : null,
        };
      });
  }

  async catalog(): Promise<DynamicCatalogEntry[]> {
    return catalogEntries(await this.client.tools(this.catalogSource));
  }

  resolve(entryName: string) {
    return resolveEntry(entryName);
  }

  /** One native call in one area's source, after the argument guard; result sanitized. */
  async call(sourceId: string, entryName: string, args: Record<string, unknown>, principalId: string): Promise<unknown> {
    const op = resolveEntry(entryName);
    if (!op) throw new EngineCallError("engine_capability_unavailable", "this engine tool is not available", 404);
    const refusal = argumentRefusal(op.name, args);
    if (refusal) throw new EngineCallError("argument_refused", refusal, 400);
    const data = await this.client.call(sourceId, op.name, args, { principalId, timeoutMs: op.long ? 300_000 : 60_000 });
    return sanitizeResult(data, sourceId);
  }

  /** Provision the engine source of an area through the C6 helper (idempotent upstream: an existing id is fine). */
  static sourceRequest(sourceId: string, label: string) {
    return { id: sourceId, name: `knowledge-${label}`.slice(0, 64) };
  }
}
