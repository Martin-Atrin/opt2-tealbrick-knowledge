// Person (owner) operations behind the Knowledge UI: browse and curate memory in every area.
// Person ops run only from the app UI in a person session (launch ticket); in opt2 only the workspace owner holds one,
// and the owner may read and curate every area (agents stay limited to their area grants).
import type { HandlerSpec, Json, OpContext } from "@opt2-tealbrick/spec/sdk";
import type { Area } from "./areas.ts";
import type { NotebookClient } from "./engines/notebook/client.ts";
import type { Knowledge, Services } from "./knowledge.ts";

type In = Record<string, any>;

export interface LibraryDeps {
  knowledge: Knowledge;
  services(ctx: OpContext): Services;
  wrap<T>(fn: () => Promise<T>): Promise<T>;
  fail(code: string, message: string, status: number): Error;
  notFound(): Error;
  recallAcross(s: Services, ctx: OpContext, areas: string[], query: string, limit: number): Promise<unknown>;
  readyArea(ctx: OpContext, s: Services, id: string, need: "source" | "notebook"): Promise<Area>;
  notebookOf(s: Services): NotebookClient;
}

export function createLibraryHandlers(d: LibraryDeps): Record<string, HandlerSpec<In, Json>> {
  const { knowledge, services, wrap, notFound } = d;
  const actor = (ctx: OpContext) => ctx.caller.id;
  const area = (s: Services, id: unknown) => {
    const found = typeof id === "string" ? s.areas.get(id) : null;
    if (!found) throw notFound();
    return found;
  };
  const doc = (s: Services, id: unknown) => {
    const found = s.store.getDocument(String(id));
    if (!found) throw notFound();
    return found;
  };
  const json = (value: unknown) => value as Json;

  return {
    library_overview: {
      run: (_input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const counts = s.store.countsByArea();
          return json({
            areas: s.areas.list().map((a) => ({
              id: a.id,
              label: a.label,
              kind: a.kind,
              documents: counts.get(a.id)?.documents ?? 0,
              collections: counts.get(a.id)?.collections ?? 0,
              engineReady: a.sourceReady,
              researchReady: a.notebookId !== null,
            })),
          });
        }),
    },

    library_collections: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          return json({ collections: s.store.listCollections(area(s, input.area).id) });
        }),
    },

    library_documents: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const areas = typeof input.area === "string" ? [area(s, input.area).id] : s.areas.list().map((a) => a.id);
          return json({ hits: s.store.search({ areas, query: input.query, collectionId: input.collectionId, limit: input.limit ?? 50 }) });
        }),
    },

    library_tree: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const collection = s.store.getCollection(String(input.collectionId));
          if (!collection) throw notFound();
          return json({ nodes: s.store.tree(collection.id) });
        }),
    },

    library_document: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const document = doc(s, input.id);
          return json({ document, revisions: s.store.revisions(document.id, 100), comments: s.store.listComments(document.id), links: s.store.listLinks(document.id) });
        }),
    },

    library_revision: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          return json(s.store.revision(doc(s, input.id).id, Number(input.version)));
        }),
    },

    library_document_create: {
      redact: (input) => `owner created document "${String(input.title).slice(0, 60)}"`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const created = s.store.createDocument({
            area: area(s, input.area).id,
            collectionId: input.collectionId,
            parentId: input.parentId,
            title: String(input.title),
            body: input.body,
            summary: input.summary,
            status: input.status,
            tags: input.tags,
            actor: actor(ctx),
          });
          knowledge.kick(s);
          return { id: created.id, version: created.version };
        }),
    },

    library_document_update: {
      redact: (input, output) => `owner edited document ${input.id} → v${(output as In | undefined)?.version ?? "?"}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const document = doc(s, input.id);
          const updated = s.store.updateDocument(document.id, { title: input.title, body: input.body, summary: input.summary, status: input.status, tags: input.tags }, input.expectedVersion, actor(ctx));
          knowledge.kick(s);
          return { id: updated.id, version: updated.version };
        }),
    },

    library_document_delete: {
      redact: (input) => `owner deleted document ${input.id}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const document = doc(s, input.id);
          s.store.deleteDocument(document.id, actor(ctx));
          knowledge.kick(s);
          return { id: document.id, deleted: true };
        }),
    },

    library_collection_create: {
      redact: (input) => `owner created collection "${String(input.name).slice(0, 60)}"`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          return { id: s.store.createCollection(area(s, input.area).id, String(input.name), input.description, actor(ctx)).id };
        }),
    },

    library_collection_delete: {
      redact: (input) => `owner deleted collection ${input.id}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const collection = s.store.getCollection(String(input.id));
          if (!collection) throw notFound();
          const { documents } = s.store.deleteCollection(collection.id, actor(ctx));
          knowledge.kick(s);
          return { id: collection.id, deleted: true, documents };
        }),
    },

    library_comment_add: {
      redact: (input) => `owner commented on ${input.documentId}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          return s.store.addComment(doc(s, input.documentId).id, String(input.body), input.parentId, actor(ctx));
        }),
    },

    library_link_delete: {
      redact: (input) => `owner removed link ${input.id}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const link = s.store.getLink(String(input.id));
          if (!link) throw notFound();
          s.store.deleteLink(link.id);
          return { id: link.id, deleted: true };
        }),
    },

    library_recall: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const areas = typeof input.area === "string" ? [area(s, input.area).id] : s.areas.list().map((a) => a.id);
          return json(await d.recallAcross(s, ctx, areas, String(input.query), Math.min(Number(input.limit ?? 20), 50)));
        }),
    },

    library_research: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const target = area(s, input.area);
          if (!s.notebook) return json({ enabled: false, sources: [], notes: [] });
          const ready = await d.readyArea(ctx, s, target.id, "notebook");
          const notebookId = ready.notebookId as string;
          return json({ enabled: true, sources: await s.notebook.listSources(notebookId, 100, 0), notes: await s.notebook.listNotes(notebookId) });
        }),
    },

    library_research_item: {
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = d.notebookOf(s);
          const ready = await d.readyArea(ctx, s, area(s, input.area).id, "notebook");
          const id = String(input.id);
          const notebookId = ready.notebookId as string;
          return json(id.startsWith("note:") ? await notebook.getNote(notebookId, id) : await notebook.getSource(notebookId, id));
        }),
    },

    library_research_source_delete: {
      redact: (input) => `owner deleted research source ${input.id}`,
      run: (input, ctx) =>
        wrap(async () => {
          const s = services(ctx);
          const notebook = d.notebookOf(s);
          const ready = await d.readyArea(ctx, s, area(s, input.area).id, "notebook");
          await notebook.deleteSource(ready.notebookId as string, String(input.id));
          return { id: String(input.id), deleted: true };
        }),
    },
  };
}
