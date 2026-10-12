// G5 `rules.narrowing` reader (SDK-API §18): exact outcomes for every shape the Rules app can send.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NarrowingError, readNarrowing, tagsPass, untaggedPass } from "../src/narrowing.ts";

test("absent key → no narrowing; v1 is read and normalized", () => {
  assert.equal(readNarrowing(undefined), null);
  assert.equal(readNarrowing({}), null);
  assert.equal(readNarrowing({ "rules.matched": { v: 1 } }), null);
  assert.deepEqual(readNarrowing({ "rules.narrowing": { v: 1, ruleId: "rul_1", reason: "r", memoryTags: { anyOf: [" Work ", "work"], noneOf: ["Personal"] } } }), {
    v: 1,
    ruleId: "rul_1",
    tags: { anyOf: ["work"], noneOf: ["personal"] },
  });
  assert.deepEqual(readNarrowing({ "rules.narrowing": { v: 1, ruleId: "rul_1", reason: "r" } }), { v: 1, ruleId: "rul_1", tags: null });
  // extra fields of a v1 value cannot widen and are ignored (L24)
  assert.deepEqual(readNarrowing({ "rules.narrowing": { v: 1, ruleId: "rul_1", reason: "r", future: true, memoryTags: { noneOf: ["x"], also: 1 } } }), { v: 1, ruleId: "rul_1", tags: { noneOf: ["x"] } });
});

test("unknown v and malformed values refuse (fail closed, 409 narrowing_unsupported)", () => {
  for (const value of [{ v: 2, ruleId: "r" }, { ruleId: "r" }, { v: "1", ruleId: "r" }, "work", null, [], { v: 1 }, { v: 1, ruleId: "r", memoryTags: "work" }, { v: 1, ruleId: "r", memoryTags: { anyOf: [1] } }]) {
    assert.throws(
      () => readNarrowing({ "rules.narrowing": value as never }),
      (error: unknown) => error instanceof NarrowingError && error.code === "narrowing_unsupported" && error.httpStatus === 409,
      JSON.stringify(value),
    );
  }
});

test("tagsPass: anyOf needs one shared tag, noneOf none; untagged items pass only without anyOf", () => {
  assert.equal(tagsPass(["work"], { anyOf: ["work"] }), true);
  assert.equal(tagsPass(["personal"], { anyOf: ["work"] }), false);
  assert.equal(tagsPass([], { anyOf: ["work"] }), false);
  assert.equal(tagsPass(["work", "personal"], { anyOf: ["work"], noneOf: ["personal"] }), false);
  assert.equal(tagsPass(["Work"], { anyOf: ["work"] }), true);
  assert.equal(tagsPass(["work"], { anyOf: [] }), false);
  assert.equal(tagsPass(["x"], null), true);
  assert.equal(untaggedPass({ noneOf: ["personal"] }), true);
  assert.equal(untaggedPass({ anyOf: ["work"] }), false);
});
