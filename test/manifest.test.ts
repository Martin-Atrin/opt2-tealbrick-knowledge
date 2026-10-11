import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve("@opt2-tealbrick/spec/schemas/manifest.schema.json"), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8"));

test("manifest validates against the frozen manifest schema", () => {
  const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const ok = validate(manifest);
  assert.ok(ok, JSON.stringify(validate.errors, null, 2));
});

test("every create op requires idempotency, outward/destructive ops write receipts (M-OP-5, M-OP-6)", () => {
  for (const op of manifest.operations) {
    if (op.crud.includes("create")) assert.equal(op.idempotency, "required", op.id);
    if (["outward", "destructive", "money"].includes(op.effect)) assert.equal(op.receipt, true, op.id);
    assert.equal(op.effect === "read", op.crud.length === 1 && op.crud[0] === "read", `M-OP-2 ${op.id}`);
    assert.ok(`knowledge__${op.id}`.length <= 64, op.id);
  }
});
