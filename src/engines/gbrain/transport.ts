// Stateless MCP transport to an unmodified upstream GBrain service (`gbrain serve --http`).
// Plain JSON-RPC POST to /mcp (no initialize handshake: upstream is stateless), JSON or SSE answers,
// bounded body, no redirects, never retries (a possibly executed write must stay uncertain).
import { randomUUID } from "node:crypto";

export const GBRAIN_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Upstream error categories that may leave Knowledge; any other upstream text is dropped. */
export const SAFE_TOOL_ERRORS: ReadonlySet<string> = new Set([
  "permission_denied", "scope_denied", "embedding_failed", "extraction_failed", "rate_limited",
  "invalid_params", "page_not_found", "revision_conflict", "unavailable", "operation_failed",
]);

export type GBrainErrorKind = "http" | "protocol" | "tool";

export class GBrainError extends Error {
  readonly kind: GBrainErrorKind;
  readonly status: number | null;
  /** allowlisted upstream code (tool errors) or null */
  readonly code: string | null;
  constructor(kind: GBrainErrorKind, message: string, opts: { status?: number; code?: string | null } = {}) {
    super(message);
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseEnvelope(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GBrainError("protocol", "invalid GBrain MCP JSON response");
  }
}

function firstText(result: Record<string, unknown>): string | undefined {
  const first = Array.isArray(result.content) ? result.content.find((item) => isRecord(item) && item.type === "text") : undefined;
  return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
}

function resultData(message: unknown, id: string): unknown {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || message.id !== id) throw new GBrainError("protocol", "invalid or mismatched GBrain MCP response");
  if ("error" in message) throw new GBrainError("protocol", "GBrain MCP protocol error");
  const result = message.result;
  if (!isRecord(result) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new GBrainError("protocol", "invalid GBrain MCP tool result");
  if (result.isError) {
    let code: unknown;
    try {
      const text = firstText(result);
      code = text ? (JSON.parse(text) as Record<string, unknown>).error : undefined;
    } catch {
      code = undefined;
    }
    const safe = typeof code === "string" && SAFE_TOOL_ERRORS.has(code) ? code : null;
    throw new GBrainError("tool", `GBrain tool execution failed${safe ? `: ${safe}` : ""}`, { code: safe });
  }
  if ("structuredContent" in result) {
    if (!isRecord(result.structuredContent)) throw new GBrainError("protocol", "invalid GBrain structured content");
    return result.structuredContent;
  }
  if (!Array.isArray(result.content)) throw new GBrainError("protocol", "missing GBrain tool content");
  const text = result.content.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text");
  if (text.some((item) => typeof item.text !== "string")) throw new GBrainError("protocol", "invalid GBrain text content");
  if (text.length === 1) {
    const only = text[0]?.text as string;
    try {
      return JSON.parse(only);
    } catch {
      return only;
    }
  }
  return result;
}

async function rpc(baseUrl: string, token: string, body: Record<string, unknown>, timeoutMs: number, fetcher: typeof fetch): Promise<{ text: string; sse: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(`${baseUrl}/mcp`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GBrainError("http", `GBrain HTTP ${response.status}`, { status: response.status });
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const sse = contentType === "text/event-stream";
    if (!sse && contentType !== "application/json") {
      await response.body?.cancel();
      throw new GBrainError("protocol", "unsupported GBrain MCP content type");
    }
    if (!response.body) throw new GBrainError("protocol", "missing GBrain MCP response body");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > GBRAIN_MAX_RESPONSE_BYTES) throw new GBrainError("protocol", "GBrain MCP response exceeds 2 MiB");
      }
      text += decoder.decode(value, { stream: !done });
      // An SSE stream may stay open after the result: stop at the first complete JSON-RPC answer.
      if (sse && /\r?\n\r?\n/u.test(text) && sseResult(text, body.id as string) !== undefined) break;
      if (done) break;
    }
    return { text, sse };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

/** First SSE event that answers `id` (progress notifications are skipped). */
function sseResult(text: string, id: string): unknown {
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data) continue;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    if (isRecord(message) && message.id === id) return message;
  }
  return undefined;
}

export interface TransportOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export async function callTool(opts: TransportOptions & { name: string; args: Record<string, unknown> }): Promise<unknown> {
  const id = randomUUID();
  const { text, sse } = await rpc(opts.baseUrl, opts.token, { jsonrpc: "2.0", id, method: "tools/call", params: { name: opts.name, arguments: opts.args } }, opts.timeoutMs ?? 30_000, opts.fetch ?? fetch);
  const message = sse ? sseResult(text, id) : parseEnvelope(text);
  if (message === undefined) throw new GBrainError("protocol", "GBrain MCP stream ended without a result");
  return resultData(message, id);
}

export async function listTools(opts: TransportOptions): Promise<Record<string, unknown>[]> {
  const id = randomUUID();
  const { text, sse } = await rpc(opts.baseUrl, opts.token, { jsonrpc: "2.0", id, method: "tools/list", params: {} }, opts.timeoutMs ?? 30_000, opts.fetch ?? fetch);
  const message = sse ? sseResult(text, id) : parseEnvelope(text);
  if (!isRecord(message) || message.id !== id || !isRecord(message.result) || !Array.isArray(message.result.tools)) {
    throw new GBrainError("protocol", "invalid GBrain MCP tools/list response");
  }
  return message.result.tools.filter(isRecord);
}
