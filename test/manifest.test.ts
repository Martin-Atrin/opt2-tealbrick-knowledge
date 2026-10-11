import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAppFiles, validateManifest } from "@opt2-tealbrick/manifest";

const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8"));
const root = new URL("..", import.meta.url).pathname;

test("manifest passes the one validator (schema + every M-* rule)", () => {
  const result = validateManifest(manifest);
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.errors, null, 2));
});

test("skill files pass validateAppFiles (frontmatter, variables, sanitized content)", async () => {
  const result = await validateAppFiles(manifest, root);
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.errors, null, 2));
});
