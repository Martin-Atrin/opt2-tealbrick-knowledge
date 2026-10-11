import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** `<prefix>_` + 20 lower-case base32 characters from the CSPRNG (never sequential: ids leak nothing). */
export function newId(prefix: "kcol" | "kdoc" | "krev" | "kcom" | "klnk"): string {
  const bytes = randomBytes(20);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return `${prefix}_${out}`;
}

/** The shared company area. */
export const SHARED_AREA_ID = "company";

/** Own area of an agent: `agent-` + the lower-cased ULID of its agent id (agt_<ULID>). */
export function agentAreaId(agentId: string): string {
  const ulid = agentId.replace(/^agt_/u, "").toLowerCase();
  if (!/^[0-9a-z]{10,40}$/u.test(ulid)) throw new Error("invalid agent id");
  return `agent-${ulid}`;
}

/** GBrain source id of an area (≤ 32 chars, upstream grammar): `ka-` + 24 hex of sha256(area id). */
export function areaSourceId(areaId: string): string {
  return `ka-${createHash("sha256").update(areaId).digest("hex").slice(0, 24)}`;
}

export const AREA_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "document"
  );
}
