// Every handler output must match its manifest output schema (the SDK answers 500 otherwise).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import { manifest } from "../src/app.ts";

test("output schemas allow every field the handlers return (sample shapes)", () => {
  const samples: Record<string, unknown> = {
    recall: { results: [], areas: [], partial: false, degraded: true },
    library_recall: { results: [], areas: [], partial: false, degraded: true },
    library_research: { enabled: false, sources: [], notes: [] },
    collection_delete: { id: "kcol_X", deleted: true, documents: 2 },
    library_collection_delete: { id: "kcol_X", deleted: true, documents: 2 },
    library_document_create: { id: "kdoc_X", version: 1 },
    remember: { documentId: "kdoc_X", area: "company", version: 1 },
  };
  for (const [id, output] of Object.entries(samples)) {
    const op = manifest.operations.find((o) => o.id === id);
    assert.ok(op?.output, id);
    const result = validateInput({ ...op, standard: false, input: op.output } as never, output as never);
    assert.ok((result as { ok: boolean }).ok, `${id}: ${JSON.stringify(result)}`);
  }
});
