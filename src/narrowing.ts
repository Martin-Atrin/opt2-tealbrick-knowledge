// G5 `rules.narrowing` (SDK-API §18, spec type RulesNarrowingV1): the Rules app's context hook narrows what a read
// or recall returns to memories whose tags satisfy `memoryTags` (anyOf: at least one, noneOf: none). Only the app
// whose product id is `rules` can write the `rules.` context namespace (the bridge namespaces context keys).
// Narrowing never widens: an unknown version or a malformed value refuses the call (fail closed).
import { normalizeTag, tagsMatch } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";

export { normalizeTag };

export const NARROWING_KEY = "rules.narrowing";
export const NARROWING_UNSUPPORTED = "narrowing_unsupported";
/** SDK-API §18.4 b (C150): a write whose result the caller could not read (409, not retryable). */
export const NARROWING_VIOLATION = "narrowing_violation";

/** A tag filter (lists normalized with the shared `normalizeTag`); the comparison is the shared `tagsMatch` (SDK-API §18.1, L1). */
export interface TagFilter {
  anyOf?: string[];
  noneOf?: string[];
}

export interface Narrowing {
  v: 1;
  ruleId: string;
  /** null when the v1 value carries no memoryTags (nothing to filter) */
  tags: TagFilter | null;
}

export class NarrowingError extends Error {
  readonly code = NARROWING_UNSUPPORTED;
  readonly httpStatus = 409;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function tagList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) throw new NarrowingError(`rules.narrowing memoryTags.${field} is not a list of tags`);
  return [...new Set((value as string[]).map(normalizeTag))];
}

/**
 * The narrowing in this call's hook context, or null when the key is absent (apply nothing). Throws NarrowingError for
 * an unknown `v` or a value that cannot be applied. Extra fields of a v1 value are ignored (they cannot widen).
 */
export function readNarrowing(context: Readonly<Record<string, Json>> | null | undefined): Narrowing | null {
  if (!context || !Object.hasOwn(context, NARROWING_KEY)) return null;
  const value = context[NARROWING_KEY];
  if (!isObject(value)) throw new NarrowingError("rules.narrowing is not an object");
  if (value.v !== 1) throw new NarrowingError(`rules.narrowing version ${JSON.stringify(value.v ?? null)} is not supported (this app reads v 1)`);
  if (typeof value.ruleId !== "string" || !value.ruleId) throw new NarrowingError("rules.narrowing has no ruleId");
  const raw = value.memoryTags;
  if (raw === undefined || raw === null) return { v: 1, ruleId: value.ruleId, tags: null };
  if (!isObject(raw)) throw new NarrowingError("rules.narrowing memoryTags is not an object");
  const anyOf = tagList(raw.anyOf, "anyOf");
  const noneOf = tagList(raw.noneOf, "noneOf");
  // Lists are kept as sent (an empty anyOf included): what they mean is decided by the shared tagsMatch alone.
  if (anyOf === undefined && noneOf === undefined) return { v: 1, ruleId: value.ruleId, tags: null };
  return { v: 1, ruleId: value.ruleId, tags: { ...(anyOf ? { anyOf } : {}), ...(noneOf ? { noneOf } : {}) } };
}

/** THE G5 comparison: the manifest package's `tagsMatch` (Rules' after hook uses the same function). */
export function tagsPass(tags: readonly string[], filter: TagFilter | null): boolean {
  return tagsMatch(filter ?? undefined, tags);
}

/** Items without tags (research sources, notes, chats): pass exactly when an item with no tags matches. */
export function untaggedPass(filter: TagFilter | null): boolean {
  return tagsMatch(filter ?? undefined, []);
}
