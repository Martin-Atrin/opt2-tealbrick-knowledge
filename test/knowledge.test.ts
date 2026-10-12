// Knowledge behaviour through its handlers with a fake SDK context and a fake GBrain service:
// per-agent areas are walled, the shared area is READ by default (C1), memory is remembered and recalled.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import { knowledgeDefinition } from "../src/app.ts";
import { memorySecrets, SECRET_NAME } from "../src/knowledge.ts";
import { context, type FakeGBrain, FakeScopes, fakeGBrain, memoryDb, TestError } from "./helpers.ts";

const ADA = "agt_01AAAAAAAAAAAAAAAAAAAAAAAA";
const BO = "agt_01BBBBBBBBBBBBBBBBBBBBBBBB";
const ADA_AREA = "agent-01aaaaaaaaaaaaaaaaaaaaaaaa";
const BO_AREA = "agent-01bbbbbbbbbbbbbbbbbbbbbbbb";

let gbrain: FakeGBrain;
before(async () => {
  gbrain = await fakeGBrain();
});
after(async () => {
  await gbrain.close();
});

async function setup() {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const env = { KNOWLEDGE_ENGINE: "gbrain", KNOWLEDGE_GBRAIN_URL: gbrain.url, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: gbrain.adminToken, KNOWLEDGE_MODEL_PROVIDER: "openai" };
  const { definition, knowledge } = knowledgeDefinition(env, TestError, { drainIntervalMs: 0 });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  for (const [id, name] of [[ADA, "Ada"], [BO, "Bo"]] as const) {
    await definition.events?.agentAdded?.({ id, name, mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp: async () => { throw new Error("no companions"); }, statusChanged() {}, ownerLink: () => null });
    scopes.applyDefaults(id);
  }
  // C6 helper stand-in: `gbrain sources add` creates the source.
  const helperCalls: unknown[] = [];
  const callServiceHelper = (async (service: string, path: string, body: Json) => {
    helperCalls.push({ service, path, body });
    gbrain.sources.add(String((body as Record<string, unknown>).id));
    return {};
  }) as OpContext["callServiceHelper"];
  const ctx = (agent: string, extra: Partial<OpContext> = {}) => context(db, scopes, agent, { callServiceHelper, ...extra });
  const run = async (name: string, input: Record<string, unknown>, c: OpContext) => {
    const spec = definition.handlers[name];
    const handler = typeof spec === "function" ? spec : spec?.run;
    if (!handler) throw new Error(`no handler ${name}`);
    const declared = definition.manifest.operations.find((o) => o.id === name);
    if (declared?.input) {
      const inputCheck = validateInput({ ...declared, standard: false } as never, input as never) as { ok: boolean };
      assert.ok(inputCheck.ok, `${name} input: ${JSON.stringify(inputCheck)}`);
    }
    const output = (await handler(input as Json, c)) as Record<string, any>;
    // The SDK refuses (500) an output that does not match the manifest output schema: check every call here too.
    const op = definition.manifest.operations.find((o) => o.id === name);
    if (op?.output) {
      const checked = validateInput({ ...op, standard: false, input: op.output } as never, output as never) as { ok: boolean };
      assert.ok(checked.ok, `${name} output: ${JSON.stringify(checked)}`);
    }
    return output;
  };
  return { db, scopes, definition, knowledge, ctx, run, helperCalls };
}

const rejects = (code: string) => (error: unknown) => error instanceof TestError && error.code === code;

test("every manifest operation has exactly one handler (dynamic op via dynamic handlers)", async () => {
  const { definition } = await setup();
  const ids = definition.manifest.operations.filter((op) => !op.dynamic).map((op) => op.id).sort();
  assert.deepEqual(Object.keys(definition.handlers).sort(), ids);
  assert.deepEqual(Object.keys(definition.dynamic ?? {}), ["engine"]);
});

test("J1: an agent remembers, the memory is projected to GBrain and recalled", async () => {
  const { ctx, run, knowledge, db, helperCalls } = await setup();
  const saved = await run("remember", { text: "Martin prefers annual billing for Acme.\nDecided on the call." }, ctx(ADA));
  assert.equal(saved.area, ADA_AREA);
  // Provisioning runs lazily on the first engine-backed call; drain the outbox.
  await run("recall", { query: "anything" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  assert.ok(helperCalls.length >= 1);
  const recalled = await run("recall", { query: "annual billing" }, ctx(ADA));
  assert.equal(recalled.degraded, false);
  assert.equal(recalled.results[0].documentId, saved.documentId);
  assert.deepEqual(recalled.results[0].areas, [ADA_AREA]);
  const state = db.prepare("SELECT state FROM kn_projection WHERE document_id = ?").get(saved.documentId);
  assert.equal(state?.state, "ready");
});

test("walled areas: another agent can neither recall nor read nor target the area", async () => {
  const { ctx, run, knowledge } = await setup();
  const saved = await run("remember", { text: "Ada's private plan: zebra project" }, ctx(ADA));
  await run("recall", { query: "x" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  const bo = await run("recall", { query: "zebra project" }, ctx(BO));
  assert.equal(bo.results.length, 0);
  await assert.rejects(run("document_get", { id: saved.documentId }, ctx(BO)), rejects("not_found"));
  await assert.rejects(run("recall", { query: "zebra", area: ADA_AREA }, ctx(BO)), rejects("not_found"));
  await assert.rejects(run("remember", { text: "intrusion", area: ADA_AREA }, ctx(BO)), rejects("not_found"));
  const search = await run("documents_search", { query: "zebra" }, ctx(BO));
  assert.equal(search.hits.length, 0);
});

test("shared company area: READ for everyone, WRITE only after the owner enables it (C1)", async () => {
  const { ctx, run, scopes } = await setup();
  await assert.rejects(run("remember", { text: "company fact", area: "company" }, ctx(ADA)), rejects("scope_denied"));
  scopes.set(ADA, "company", "read_write");
  const saved = await run("remember", { text: "Company holiday is May 1", area: "company" }, ctx(ADA));
  const doc = await run("document_get", { id: saved.documentId }, ctx(BO));
  assert.equal(doc.area, "company");
  const areas = await run("areas_list", {}, ctx(BO));
  assert.deepEqual(
    areas.areas.map((a: Record<string, unknown>) => [a.id, a.access, a.own]),
    [["company", "read", false], [BO_AREA, "read_write", true]],
  );
  await assert.rejects(run("document_update", { id: saved.documentId, body: "changed" }, ctx(BO)), rejects("scope_denied"));
});

test("recall falls back to keyword search when the engine cannot answer (degraded, never silent)", async () => {
  const db = memoryDb();
  const scopes = new FakeScopes();
  const { definition } = knowledgeDefinition({ KNOWLEDGE_ENGINE: "gbrain" }, TestError, { drainIntervalMs: 0 });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  await definition.events?.agentAdded?.({ id: ADA, name: "Ada", mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log, callApp: async () => { throw new Error("no companions"); }, statusChanged() {}, ownerLink: () => null });
  scopes.applyDefaults(ADA);
  const spec = definition.handlers.remember as { run: (i: Json, c: OpContext) => Promise<Json> };
  await spec.run({ text: "the walrus sings at noon" }, context(db, scopes, ADA));
  const recall = definition.handlers.recall as { run: (i: Json, c: OpContext) => Promise<Record<string, any>> };
  const out = await recall.run({ query: "walrus" }, context(db, scopes, ADA));
  assert.equal(out.degraded, true);
  assert.equal(out.results.length, 1);
  assert.ok(out.areas.every((a: Record<string, unknown>) => a.via === "keyword"));
});

test("engine tools: catalog filters policy exclusions and source_id; calls are area-bound and guarded", async () => {
  const { ctx, run, definition } = await setup();
  await run("recall", { query: "warm up" }, ctx(ADA)); // provisions the sources
  const dynamic = definition.dynamic?.engine;
  assert.ok(dynamic);
  const hookCtx = { db: ctx(ADA).db, log: ctx(ADA).log, getKey: async () => null, signal: new AbortController().signal, secrets: memorySecrets() };
  const catalog = await dynamic.catalog(null, hookCtx);
  const names = catalog.map((entry) => entry.name);
  assert.ok(names.includes("gb_remember"));
  assert.ok(!names.includes("gb_sources_list"));
  const remember = catalog.find((entry) => entry.name === "gb_remember");
  assert.equal((remember?.inputSchema.properties as Record<string, unknown> | undefined)?.source_id, undefined);
  assert.deepEqual(await dynamic.resolve("gb_forget", hookCtx), { tool: "gb_forget", crud: ["delete"], effect: "destructive", holdFamily: "destructive" });
  assert.equal(await dynamic.resolve("gb_sources_list", hookCtx), null);

  gbrain.calls.length = 0;
  await dynamic.call("gb_remember", { fact: "Ada likes tea" }, ctx(ADA, { idempotencyKey: "idem-".padEnd(12, "0") }));
  const call = gbrain.calls.find((c) => c.name === "remember");
  assert.ok(call && typeof call.args.request_id === "string");
  assert.equal(call.args.area, undefined);

  await assert.rejects(dynamic.call("gb_remember", { fact: "x", source_id: "other" }, ctx(ADA)), rejects("argument_refused"));
  await assert.rejects(dynamic.call("gb_remember", { fact: "x", area: "company" }, ctx(ADA)), rejects("scope_denied"));
  await assert.rejects(dynamic.call("gb_entity", { name: "x", area: ADA_AREA }, ctx(BO)), rejects("not_found"));

  // Stateless reads fan out over every readable area; a foreign-source row is dropped by the sanitizer.
  gbrain.answer = (source, name) => (name === "entity" ? [{ name: "Acme", source_id: source }, { name: "Leak", source_id: "ka-other" }] : undefined);
  const fan = (await dynamic.call("gb_entity", { name: "Acme" }, ctx(BO))) as Record<string, any>;
  gbrain.answer = undefined;
  assert.deepEqual(fan.areas.map((a: Record<string, unknown>) => a.area).sort(), ["company", BO_AREA].sort());
  for (const result of fan.results) assert.deepEqual(result.data.map((row: Record<string, unknown>) => row.name), ["Acme"]);
});

test("delete removes the memory from the engine", async () => {
  const { ctx, run, knowledge } = await setup();
  const saved = await run("remember", { text: "temporary note about lemons" }, ctx(ADA));
  await run("recall", { query: "x" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  await run("document_delete", { id: saved.documentId }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  const out = await run("recall", { query: "lemons" }, ctx(ADA));
  assert.equal(out.results.length, 0);
});

test("after a restore every live document is re-projected (engine state may differ from app.db)", async () => {
  const { ctx, run, knowledge, db } = await setup();
  await run("remember", { text: "restore check about plums" }, ctx(ADA));
  await knowledge.current()?.projector?.drain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kn_projection WHERE state = 'pending'").get()?.n, 0);
  assert.ok((knowledge.current()?.projector?.requeueAll() ?? 0) >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kn_projection WHERE state = 'pending' AND content_hash IS NULL").get()?.n, 1);
  await knowledge.current()?.projector?.drain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kn_projection WHERE state = 'ready'").get()?.n, 1);
});

test("QA S2: recall uses GBrain when it is up (not degraded) and engine client credentials use valid SDK secret names", async () => {
  const names: string[] = [];
  const strict = memorySecrets();
  const secrets = {
    ...strict,
    put: async (name: string, value: string) => {
      names.push(name);
      await strict.put(name, value);
    },
  };
  const { ctx, run, knowledge } = await setup();
  const withSecrets = (agent: string) => ctx(agent, { secrets } as never);
  const saved = await run("remember", { text: "GBrain path check: the quokka report" }, withSecrets(ADA));
  await knowledge.current()?.projector?.drain();
  gbrain.calls.length = 0;
  const out = await run("recall", { query: "quokka report" }, withSecrets(ADA));
  assert.equal(out.degraded, false, JSON.stringify(out.areas));
  assert.ok(out.areas.every((a: Record<string, unknown>) => a.via === "engine"));
  assert.ok(gbrain.calls.some((c) => c.name === "query"));
  assert.equal(out.results[0].documentId, saved.documentId);
  assert.ok(names.length > 0);
  for (const name of names) assert.match(name, SECRET_NAME);
});

test("C58 agent ops: collection get/tree/delete and link delete stay inside the caller's writable areas", async () => {
  const { ctx, run } = await setup();
  await run("remember", { text: "seed the default collection" }, ctx(ADA));
  const col = await run("collection_create", { name: "Projects" }, ctx(ADA));
  const parent = await run("document_create", { title: "Plan", collectionId: col.id }, ctx(ADA));
  const child = await run("document_create", { title: "Step", collectionId: col.id, parentId: parent.id }, ctx(ADA));
  const tree = await run("collection_tree", { id: col.id }, ctx(ADA));
  assert.equal(tree.nodes[0].id, parent.id);
  assert.equal(tree.nodes[0].children[0].id, child.id);
  assert.equal((await run("collection_get", { id: col.id }, ctx(ADA))).documentCount, 2);
  await assert.rejects(run("collection_get", { id: col.id }, ctx(BO)), rejects("not_found"));
  const link = await run("link_add", { sourceId: child.id, targetId: parent.id }, ctx(ADA));
  await assert.rejects(run("link_delete", { id: link.id }, ctx(BO)), rejects("not_found"));
  assert.equal((await run("link_delete", { id: link.id }, ctx(ADA))).deleted, true);
  await assert.rejects(run("collection_delete", { id: col.id }, ctx(BO)), rejects("not_found"));
  const deleted = await run("collection_delete", { id: col.id }, ctx(ADA));
  assert.equal(deleted.documents, 2);
  await assert.rejects(run("document_get", { id: parent.id }, ctx(ADA)), rejects("not_found"));
  const def = (await run("collections_list", {}, ctx(ADA))).collections.find((c: Record<string, unknown>) => c.isDefault);
  await assert.rejects(run("collection_delete", { id: def.id }, ctx(ADA)), rejects("default_collection"));
});

test("C58 person ops: the owner browses and curates every area", async () => {
  const { ctx, run, knowledge } = await setup();
  const saved = await run("remember", { text: "Ada's note about walruses" }, ctx(ADA));
  const bo = await run("remember", { text: "Bo's note about walruses" }, ctx(BO));
  const owner = ctx(ADA, { caller: { type: "person", id: "per_01OWNER000000000000000000" as `per_${string}`, name: "Owner", mode: null } });
  const overview = await run("library_overview", {}, owner);
  assert.deepEqual(overview.areas.map((a: Record<string, unknown>) => a.id).sort(), ["company", ADA_AREA, BO_AREA].sort());
  assert.equal((await run("library_documents", { query: "walruses" }, owner)).hits.length, 2);
  assert.equal((await run("library_documents", { area: ADA_AREA, query: "walruses" }, owner)).hits.length, 1);
  const detail = await run("library_document", { id: saved.documentId }, owner);
  assert.equal(detail.document.area, ADA_AREA);
  assert.equal(detail.revisions.length, 1);
  const edited = await run("library_document_update", { id: saved.documentId, body: "edited by owner", expectedVersion: 1 }, owner);
  assert.equal(edited.version, 2);
  await assert.rejects(run("library_document_update", { id: saved.documentId, body: "stale", expectedVersion: 1 }, owner), rejects("version_conflict"));
  assert.equal((await run("library_revision", { id: saved.documentId, version: 1 }, owner)).body, "Ada's note about walruses");
  await run("library_comment_add", { documentId: saved.documentId, body: "checked" }, owner);
  assert.equal((await run("library_document", { id: saved.documentId }, owner)).comments.length, 1);
  await knowledge.current()?.projector?.drain();
  const recall = await run("library_recall", { query: "walruses" }, owner);
  assert.equal(recall.degraded, false, JSON.stringify(recall.areas));
  assert.ok(recall.results.some((r: Record<string, unknown>) => r.documentId === bo.documentId));
  assert.equal((await run("library_research", { area: ADA_AREA }, owner)).enabled, false);
  await run("library_document_delete", { id: saved.documentId }, owner);
  await assert.rejects(run("library_document", { id: saved.documentId }, owner), rejects("not_found"));
});
