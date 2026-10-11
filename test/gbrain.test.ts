import assert from "node:assert/strict";
import { test } from "node:test";
import { gbrainExposure } from "../src/engines/gbrain/exposure.ts";
import { argumentRefusal } from "../src/engines/gbrain/guard.ts";
import { neutralizeFenceMarkers, sanitizeResult, stripPrivacyFences } from "../src/engines/gbrain/privacy.ts";

test("privacy fences are stripped, nested and unclosed fences drop their contents (A7)", () => {
  const open = "<!--- gbrain:facts:begin -->";
  const close = "<!--- gbrain:facts:end -->";
  assert.equal(stripPrivacyFences(`a${open}secret${close}b`), "ab");
  assert.equal(stripPrivacyFences(`a${open}x${open}y${close}z${close}b`), "ab");
  assert.equal(stripPrivacyFences(`a${open}never closed`), "a");
  assert.equal(stripPrivacyFences(`a${close}b`), "ab");
});

test("sanitizer drops foreign-source rows and withheld keys (A6, A9, A13)", () => {
  const out = sanitizeResult(
    { items: [{ id: 1, source_id: "ka-mine" }, { id: 2, source_id: "ka-other" }], pending_consolidation_count: 3, card: { open_loops: [1] } },
    "ka-mine",
  ) as Record<string, any>;
  assert.deepEqual(out.items, [{ id: 1, source_id: "ka-mine" }]);
  assert.equal("pending_consolidation_count" in out, false);
  assert.deepEqual(out.card, {});
  assert.equal(sanitizeResult({ id: 9, source_id: "ka-other" }, "ka-mine"), null);
});

test("fence markers in canonical text are escaped before projection", () => {
  assert.equal(neutralizeFenceMarkers("x <!--- gbrain:facts:begin --> y"), "x &lt;!--- gbrain:facts:begin --> y");
});

test("argument guard refuses source selection, host access, private facts and forced writes", () => {
  assert.ok(argumentRefusal("query", { source_id: "x" }));
  assert.ok(argumentRefusal("remember", { visibility: "private" }));
  assert.ok(argumentRefusal("capture", { local_file: "/etc/passwd" }));
  assert.ok(argumentRefusal("search_by_image", { image_url: "file:///etc/passwd" }));
  assert.ok(argumentRefusal("search_by_image", { image_url: "https://ex ample.com/a.png" }));
  assert.equal(argumentRefusal("search_by_image", { image_url: "https://example.com/a.png" }), null);
  assert.ok(argumentRefusal("takes_add", { local_dir: "/tmp" }));
  assert.ok(argumentRefusal("put_page", { slug: "knowledge-docs/kdoc_x", content: "x" }));
  assert.ok(argumentRefusal("put_page", { slug: "notes/a", content: "x", force: true }));
  assert.equal(argumentRefusal("remember", { fact: "ok" }), null);
});

test("exposure at the pin: 88 tools exposed, every write classified, destructive ops held", () => {
  const exposure = gbrainExposure();
  assert.equal(exposure.exposed.size + exposure.excluded.size, 156);
  assert.equal(exposure.exposed.size, 88);
  assert.ok(exposure.exposed.size <= 256);
  for (const op of exposure.exposed.values()) {
    assert.equal(op.effect === "read", op.crud.length === 1 && op.crud[0] === "read", op.name);
    if (op.crud.includes("delete")) assert.equal(op.holdFamily, "destructive", op.name);
  }
  assert.ok(exposure.excluded.has("sources_list"));
});
