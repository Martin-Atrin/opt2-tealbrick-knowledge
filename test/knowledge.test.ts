// Knowledge behaviour through its handlers with a fake SDK context and a fake GBrain service:
// per-agent areas are walled, the shared area is READ by default (C1), memory is remembered and recalled.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
    await definition.events?.agentAdded?.({ id, name, mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log });
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
  const run = async (op: string, input: Record<string, unknown>, c: OpContext) => {
    const spec = definition.handlers[op];
    const handler = typeof spec === "function" ? spec : spec?.run;
    if (!handler) throw new Error(`no handler ${op}`);
    return (await handler(input as Json, c)) as Record<string, any>;
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
  await definition.events?.agentAdded?.({ id: ADA, name: "Ada", mode: "free", status: "active" }, { db, scopes: scopes.asStore(), log });
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
