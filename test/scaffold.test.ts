import { test } from "node:test";
import assert from "node:assert/strict";
import type { AreaBinding } from "../src/engines/engine.ts";

test("area binding read set contains the write area", () => {
  const binding: AreaBinding = { write: "agent-a", read: ["agent-a", "shared"] };
  assert.ok(binding.read.includes(binding.write));
});
