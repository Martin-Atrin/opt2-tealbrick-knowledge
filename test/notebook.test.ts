import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { NotebookClient, NotebookError } from "../src/engines/notebook/client.ts";

const NB = "notebook:n1";
const OTHER = "notebook:n2";
const sources = new Map<string, { notebook: string; title: string; full_text: string }>([["source:s2", { notebook: OTHER, title: "other", full_text: "secret" }]]);
const session = { id: "chat_session:c1", notebook_id: NB, model_override: "model:m1", messages: [] as { id: string; type: string; content: string }[] };
let failExecute = false;
let url = "";
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.headers.authorization !== "Bearer pw") return json(401, {});
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/api/sources" && req.method === "GET") {
    const nb = u.searchParams.get("notebook_id");
    return json(200, [...sources].filter(([, s]) => s.notebook === nb).map(([id, s]) => ({ id, title: s.title, updated: "t" })));
  }
  if (u.pathname.startsWith("/api/sources/") && req.method === "GET") {
    const id = decodeURIComponent(u.pathname.slice("/api/sources/".length));
    const s = sources.get(id);
    return s ? json(200, { id, title: s.title, full_text: s.full_text, notebooks: [s.notebook] }) : json(404, {});
  }
  if (u.pathname === "/api/sources/json") {
    const id = `source:s${sources.size + 10}`;
    sources.set(id, { notebook: body.notebooks[0], title: body.title, full_text: body.content });
    return json(200, { id });
  }
  if (u.pathname === "/api/notes") return json(200, []);
  if (u.pathname === `/api/chat/sessions/${encodeURIComponent(session.id)}`) return json(200, session);
  if (u.pathname === "/api/chat/execute") {
    if (failExecute) return json(500, {});
    session.messages.push({ id: "m-h", type: "human", content: body.message }, { id: "m-a", type: "ai", content: "grounded answer" });
    return json(200, { session_id: session.id, messages: session.messages });
  }
  json(404, {});
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("a source of another notebook answers like a missing one", async () => {
  const client = new NotebookClient({ baseUrl: url, password: "pw" });
  await assert.rejects(client.getSource(NB, "source:s2"), (e: unknown) => e instanceof NotebookError && e.code === "not_found");
});

test("text source add verifies membership; chat answer recovered by exact history diff", async () => {
  const client = new NotebookClient({ baseUrl: url, password: "pw" });
  const id = await client.addTextSource(NB, "Acme notes", "Acme renews in May");
  assert.equal((await client.getSource(NB, id)).fullText, "Acme renews in May");
  const answer = await client.ask(NB, session.id, "model:m1", "When does Acme renew?");
  assert.deepEqual(answer, { id: "m-a", type: "ai", content: "grounded answer" });
  await assert.rejects(client.getSession(OTHER, session.id), (e: unknown) => e instanceof NotebookError && e.code === "not_found");
});

test("a failed execute is ambiguous (may have run); a model mismatch is rejected before dispatch", async () => {
  const client = new NotebookClient({ baseUrl: url, password: "pw" });
  await assert.rejects(client.ask(NB, session.id, "model:other", "q"), (e: unknown) => e instanceof NotebookError && e.disposition === "rejected");
  failExecute = true;
  await assert.rejects(client.ask(NB, session.id, "model:m1", "q"), (e: unknown) => e instanceof NotebookError && e.disposition === "ambiguous");
  failExecute = false;
});
