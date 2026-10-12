// The conformance stub engine lives only in conformance.start.ts behind TBCONF_STUB_ENGINE (CONFORMANCE v0.1.18).
// No product code under src/ may read a harness variable, so the stub cannot be reached in the shipped image.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
}

test("no file under src/ reads a TBCONF_ harness variable", () => {
  const all = files(SRC);
  assert.ok(all.length > 10, "the scan found the source tree");
  const hits = all.filter((file) => readFileSync(file, "utf8").includes("TBCONF_"));
  assert.deepEqual(hits, [], "harness variables are read only by conformance.start.ts");
});
