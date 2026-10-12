// G5 `rules.narrowing` (SDK-API §18, spec type RulesNarrowingV1): the Rules app's context hook narrows what a read
// or recall returns to memories whose tags satisfy `memoryTags` (anyOf: at least one, noneOf: none). Only the app
// whose product id is `rules` can write the `rules.` context namespace (the bridge namespaces context keys).
// Narrowing never widens: an unknown version or a malformed value refuses the call (fail closed).
import type { Json } from "@opt2-tealbrick/spec/sdk";

export const NARROWING_KEY = "rules.narrowing";
export const NARROWING_UNSUPPORTED = "narrowing_unsupported";

/** One tag rule for the whole app: stored tags and narrowing tags compare after trim + lower case. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** A tag filter after normalization; `anyOf: []` keeps nothing (no tag can intersect an empty list). */
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
  if (anyOf === undefined && !noneOf?.length) return { v: 1, ruleId: value.ruleId, tags: null };
  return { v: 1, ruleId: value.ruleId, tags: { ...(anyOf ? { anyOf } : {}), ...(noneOf?.length ? { noneOf } : {}) } };
}

/** Tags pass: at least one of `anyOf` (when given) and none of `noneOf`. Untagged items fail any `anyOf`. */
export function tagsPass(tags: readonly string[], filter: TagFilter | null): boolean {
  if (!filter) return true;
  const own = new Set(tags.map(normalizeTag));
  if (filter.anyOf && !filter.anyOf.some((tag) => own.has(tag))) return false;
  if (filter.noneOf?.some((tag) => own.has(tag))) return false;
  return true;
}

/** Items without tags (research sources, notes, chats) pass only when no `anyOf` is given. */
export function untaggedPass(filter: TagFilter | null): boolean {
  return tagsPass([], filter);
}
