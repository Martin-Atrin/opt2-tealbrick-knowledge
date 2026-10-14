// Library page: area -> collection -> document. Navigation state lives in App so Recall and Research can open a document here.
import { Button, Dialog, Field, Notice, Select, Tabs, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDelete, ErrorNotice, errText, isConflict, run, type Status, statusTone, TextBlock, useDebounced, useOverview, when } from "./common.tsx";

/** Empty string means "not chosen". */
export interface LibraryNav {
  area: string;
  collectionId: string;
  documentId: string;
}
export type SetNav = (patch: Partial<LibraryNav>) => void;

interface Collection {
  id: string;
  area: string;
  name: string;
  description: string;
  isDefault: boolean;
  documentCount: number;
}
interface Hit {
  id: string;
  area: string;
  collectionId: string;
  title: string;
  summary: string | null;
  excerpt: string;
  status: Status;
  tags: string[];
  updatedAt: number;
}
interface TreeNode {
  id: string;
  title: string;
  status: Status;
  updatedAt: number;
  children: TreeNode[];
}
interface DocLink {
  id: string;
  type: string;
  documentId: string;
  title: string;
  updatedAt: number;
}
interface Comment {
  id: string;
  parentId: string | null;
  body: string;
  createdBy: string;
  createdAt: number;
}
interface DocResponse {
  document: {
    id: string;
    area: string;
    collectionId: string;
    parentId: string | null;
    title: string;
    slug: string;
    summary: string | null;
    body: string;
    status: Status;
    tags: string[];
    version: number;
    createdBy: string;
    updatedBy: string;
    createdAt: number;
    updatedAt: number;
  };
  revisions: { version: number; title: string; summary: string | null; createdBy: string; createdAt: number }[];
  comments: Comment[];
  links: { outbound: DocLink[]; backlinks: DocLink[] };
}
interface Revision {
  version: number;
  title: string;
  summary: string | null;
  body: string;
  status: Status;
  tags: string[];
  createdBy: string;
  createdAt: number;
}

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "archived", label: "Archived" },
];

export function Library({ nav, setNav }: { nav: LibraryNav; setNav: SetNav }) {
  const { areas, engine, error } = useOverview();
  useEffect(() => {
    if (areas?.length && !areas.some((a) => a.id === nav.area) && !nav.documentId) setNav({ area: areas[0]?.id ?? "", collectionId: "" });
  }, [areas, nav.area, nav.documentId, setNav]);
  if (error) return <ErrorNotice error={error} />;
  if (!areas) return <p className="kn-muted">Loading…</p>;
  if (!areas.length) return <Notice tone="action">No memory area is available yet.</Notice>;
  const engineNotice = engine?.attention ? <Notice tone="action">{engine.attention.reason}</Notice> : null;
  if (nav.documentId) return <DocumentView id={nav.documentId} nav={nav} setNav={setNav} />;
  return (
    <>
      {engineNotice}
      <Browse areas={areas} nav={nav} setNav={setNav} />
    </>
  );
}

function Browse({ areas, nav, setNav }: { areas: { id: string; label: string; documents?: number }[]; nav: LibraryNav; setNav: SetNav }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [view, setView] = useState<"list" | "outline">("list");
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docBody, setDocBody] = useState("");

  const loadCollections = useCallback(() => {
    if (!nav.area) return;
    run<{ collections: Collection[] }>("library_collections", { area: nav.area })
      .then((r) => setCollections(r.collections))
      .catch((e: unknown) => setError(errText(e)));
  }, [nav.area]);
  useEffect(loadCollections, [loadCollections]);

  const loadHits = useCallback(() => {
    if (!nav.area) return () => {};
    let live = true;
    setLoading(true);
    run<{ hits: Hit[] }>("library_documents", { area: nav.area, collectionId: nav.collectionId || undefined, query: debounced.trim() || undefined, limit: 50 })
      .then((r) => {
        if (live) {
          setHits(r.hits);
          setError(null);
        }
      })
      .catch((e: unknown) => live && setError(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [nav.area, nav.collectionId, debounced]);
  useEffect(loadHits, [loadHits]);

  useEffect(() => {
    if (view !== "outline" || !nav.collectionId) return;
    let live = true;
    run<{ nodes: TreeNode[] }>("library_tree", { collectionId: nav.collectionId })
      .then((r) => live && setTree(r.nodes))
      .catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [view, nav.collectionId]);

  const selected = collections.find((c) => c.id === nav.collectionId);

  const createDocument = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await run<{ id: string }>(
        "library_document_create",
        { area: nav.area, collectionId: nav.collectionId || undefined, title: docTitle.trim(), body: docBody, status: "published" },
        true,
      );
      setWriting(false);
      setDocTitle("");
      setDocBody("");
      setNav({ documentId: r.id });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await run<{ id: string }>("library_collection_create", { area: nav.area, name: name.trim(), description: description.trim() || undefined }, true);
      setCreating(false);
      setName("");
      setDescription("");
      setNav({ collectionId: r.id });
      loadCollections();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const removeCollection = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await run<{ documents: number }>("library_collection_delete", { id: selected.id });
      setDeleting(false);
      setNotice(`Collection "${selected.name}" removed with ${r.documents} document${r.documents === 1 ? "" : "s"}.`);
      setNav({ collectionId: "" });
      loadCollections();
    } catch (e) {
      setError(errText(e));
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="kn-row">
        <Field label="Memory area">
          <Select
            options={areas.map((a) => ({ value: a.id, label: a.label }))}
            value={nav.area}
            onChange={(event) => {
              setNav({ area: event.target.value, collectionId: "" });
              setQuery("");
              setNotice(null);
            }}
          />
        </Field>
      </div>
      <ErrorNotice error={error} />
      {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
      <div className="kn-split kn-section">
        <nav className="kn-side" aria-label="Collections">
          <div className="kn-row">
            <strong>Collections</strong>
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              New collection
            </Button>
          </div>
          <ul className="kn-list">
            <li>
              <button type="button" className="kn-pick" aria-pressed={!nav.collectionId} onClick={() => setNav({ collectionId: "" })}>
                All documents
              </button>
            </li>
            {collections.map((c) => (
              <li key={c.id}>
                <button type="button" className="kn-pick" aria-pressed={nav.collectionId === c.id} onClick={() => setNav({ collectionId: c.id })}>
                  {c.name} <span className="kn-muted">({c.documentCount})</span>
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <div className="kn-section">
              {selected.description ? <p className="kn-muted">{selected.description}</p> : null}
              {selected.isDefault ? null : (
                <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
                  Remove collection
                </Button>
              )}
            </div>
          ) : null}
        </nav>
        <section aria-label="Documents">
          <div className="kn-row">
            <Button size="sm" variant="secondary" onClick={() => setWriting(true)}>
              New document
            </Button>
            <Field label="Search documents">
              <TextInput type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Words from a title or body" />
            </Field>
            {nav.collectionId ? (
              <Tabs
                label="Document view"
                tabs={[
                  { value: "list", label: "List" },
                  { value: "outline", label: "Outline" },
                ]}
                value={view}
                onChange={setView}
              />
            ) : null}
          </div>
          {view === "outline" && nav.collectionId ? (
            <Outline nodes={tree} onOpen={(id) => setNav({ documentId: id })} />
          ) : (
            <DocList hits={hits} loading={loading} searching={debounced.trim() !== ""} onOpen={(id) => setNav({ documentId: id })} />
          )}
        </section>
      </div>
      <Dialog
        open={writing}
        title="New document"
        onClose={() => setWriting(false)}
        busy={busy}
        footer={
          <>
            <Button variant="secondary" onClick={() => setWriting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void createDocument()} disabled={busy || !docTitle.trim()}>
              {busy ? "Saving…" : "Create"}
            </Button>
          </>
        }
      >
        <Field label="Title">
          <TextInput value={docTitle} onChange={(event) => setDocTitle(event.target.value)} maxLength={200} />
        </Field>
        <Field label="Text">
          <textarea className="tb-textarea" rows={8} value={docBody} onChange={(event) => setDocBody(event.target.value)} />
        </Field>
      </Dialog>
      <Dialog
        open={creating}
        title="New collection"
        onClose={() => setCreating(false)}
        busy={busy}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Create"}
            </Button>
          </>
        }
      >
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
        </Field>
        <Field label="Description (optional)">
          <textarea className="tb-textarea" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </Dialog>
      <ConfirmDelete
        open={deleting}
        title="Remove collection"
        what={
          <>
            the collection <strong>{selected?.name}</strong> and its {selected?.documentCount ?? 0} documents
          </>
        }
        busy={busy}
        onConfirm={() => void removeCollection()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}

function DocList({ hits, loading, searching, onOpen }: { hits: Hit[]; loading: boolean; searching: boolean; onOpen: (id: string) => void }) {
  if (!hits.length) return <p className="kn-muted kn-section">{loading ? "Loading…" : searching ? "No document matches this search." : "No documents here yet."}</p>;
  return (
    <table className="kn-table kn-section" aria-busy={loading}>
      <thead>
        <tr>
          <th>Title</th>
          <th>Status</th>
          <th>Tags</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((hit) => (
          <tr key={hit.id}>
            <td>
              <button type="button" className="kn-link" onClick={() => onOpen(hit.id)}>
                {hit.title || "Untitled"}
              </button>
              {hit.excerpt || hit.summary ? <div className="kn-muted kn-clip">{hit.excerpt || hit.summary}</div> : null}
            </td>
            <td>
              <Tag tone={statusTone(hit.status)}>{hit.status}</Tag>
            </td>
            <td className="kn-row">
              {hit.tags.map((tag) => (
                <Tag key={tag} tone="neutral">
                  {tag}
                </Tag>
              ))}
            </td>
            <td>{when(hit.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Outline({ nodes, onOpen }: { nodes: TreeNode[]; onOpen: (id: string) => void }) {
  if (!nodes.length) return <p className="kn-muted kn-section">No documents in this collection yet.</p>;
  return (
    <ul className="kn-tree kn-section">
      {nodes.map((node) => (
        <li key={node.id}>
          <button type="button" className="kn-link" onClick={() => onOpen(node.id)}>
            {node.title || "Untitled"}
          </button>{" "}
          <Tag tone={statusTone(node.status)}>{node.status}</Tag>
          {node.children.length ? <Outline nodes={node.children} onOpen={onOpen} /> : null}
        </li>
      ))}
    </ul>
  );
}

function DocumentView({ id, nav, setNav }: { id: string; nav: LibraryNav; setNav: SetNav }) {
  const [data, setData] = useState<DocResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [linkToDelete, setLinkToDelete] = useState<DocLink | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return run<DocResponse>("library_document", { id })
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => setError(errText(e)));
  }, [id]);
  useEffect(() => {
    setData(null);
    setRevision(null);
    setNotice(null);
    void load();
  }, [load]);

  const doc = data?.document;
  useEffect(() => {
    if (doc && (doc.area !== nav.area || doc.collectionId !== nav.collectionId)) setNav({ area: doc.area, collectionId: doc.collectionId });
  }, [doc, nav.area, nav.collectionId, setNav]);

  const back = <Button size="sm" variant="secondary" onClick={() => setNav({ documentId: "" })}>Back to documents</Button>;
  if (!data || !doc) {
    return (
      <div>
        <div className="kn-row">{back}</div>
        <ErrorNotice error={error} />
        {error ? null : <p className="kn-muted">Loading…</p>}
      </div>
    );
  }

  const openRevision = async (version: number) => {
    setError(null);
    try {
      setRevision(await run<Revision>("library_revision", { id, version }));
    } catch (e) {
      setError(errText(e));
    }
  };

  const save = async (patch: { title: string; summary: string; body: string; status: Status; tags: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      await run("library_document_update", { id, expectedVersion: doc.version, ...patch });
      setEditing(false);
      setNotice("Saved.");
      await load();
    } catch (e) {
      setEditing(false);
      if (isConflict(e)) {
        setNotice(null);
        setError("Someone else changed this document while you edited. Your change was not saved. The latest version is shown now.");
        await load();
      } else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await run("library_document_delete", { id });
      setNav({ documentId: "" });
    } catch (e) {
      setError(errText(e));
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  };

  const removeLink = async () => {
    if (!linkToDelete) return;
    setBusy(true);
    try {
      await run("library_link_delete", { id: linkToDelete.id });
      setLinkToDelete(null);
      await load();
    } catch (e) {
      setError(errText(e));
      setLinkToDelete(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article>
      <div className="kn-row">
        {back}
        <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
          Remove
        </Button>
      </div>
      <ErrorNotice error={error} />
      {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
      <h2 className="kn-title">{doc.title || "Untitled"}</h2>
      <div className="kn-row">
        <Tag tone={statusTone(doc.status)}>{doc.status}</Tag>
        {doc.tags.map((tag) => (
          <Tag key={tag} tone="neutral">
            {tag}
          </Tag>
        ))}
        <span className="kn-muted">
          Version {doc.version}, updated {when(doc.updatedAt)} by {doc.updatedBy}
        </span>
      </div>
      {doc.summary ? <p>{doc.summary}</p> : null}
      <TextBlock text={doc.body} label="Document text" />

      <h3 className="kn-section">History</h3>
      {data.revisions.length ? (
        <ul className="kn-list">
          {data.revisions.map((rev) => (
            <li key={rev.version}>
              <button type="button" className="kn-link" onClick={() => void openRevision(rev.version)}>
                Version {rev.version}
              </button>{" "}
              <span className="kn-muted">
                {rev.title || "Untitled"}, {when(rev.createdAt)} by {rev.createdBy}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="kn-muted">No earlier versions.</p>
      )}
      {revision ? (
        <div className="kn-revision">
          <div className="kn-row">
            <strong>
              Version {revision.version} (read only): {revision.title || "Untitled"}
            </strong>
            <Tag tone={statusTone(revision.status)}>{revision.status}</Tag>
            <Button size="sm" variant="ghost" onClick={() => setRevision(null)}>
              Close version
            </Button>
          </div>
          {revision.summary ? <p>{revision.summary}</p> : null}
          <TextBlock text={revision.body} label={`Text of version ${revision.version}`} />
        </div>
      ) : null}

      <h3 className="kn-section">Links</h3>
      <div className="kn-links">
        <LinkList heading="Links to" links={data.links.outbound} onOpen={(docId) => setNav({ documentId: docId })} onDelete={setLinkToDelete} />
        <LinkList heading="Linked from" links={data.links.backlinks} onOpen={(docId) => setNav({ documentId: docId })} onDelete={setLinkToDelete} />
      </div>

      <Comments documentId={id} comments={data.comments} onChanged={load} onError={setError} />

      <EditDialog open={editing} doc={doc} busy={busy} onClose={() => setEditing(false)} onSave={save} />
      <ConfirmDelete
        open={deleting}
        title="Remove document"
        what={
          <>
            the document <strong>{doc.title || "Untitled"}</strong>
          </>
        }
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(false)}
      />
      <ConfirmDelete
        open={linkToDelete !== null}
        title="Remove link"
        what={
          <>
            the link to <strong>{linkToDelete?.title || "this document"}</strong>
          </>
        }
        busy={busy}
        onConfirm={() => void removeLink()}
        onClose={() => setLinkToDelete(null)}
      />
    </article>
  );
}

function LinkList({ heading, links, onOpen, onDelete }: { heading: string; links: DocLink[]; onOpen: (id: string) => void; onDelete: (link: DocLink) => void }) {
  return (
    <div>
      <strong>{heading}</strong>
      {links.length ? (
        <ul className="kn-list">
          {links.map((link) => (
            <li key={link.id} className="kn-row">
              <button type="button" className="kn-link" onClick={() => onOpen(link.documentId)}>
                {link.title || "Untitled"}
              </button>
              <Tag tone="neutral">{link.type}</Tag>
              <Button size="sm" variant="ghost" aria-label={`Remove link to ${link.title || "Untitled"}`} onClick={() => onDelete(link)}>
                Remove link
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="kn-muted">None.</p>
      )}
    </div>
  );
}

function Comments({ documentId, comments, onChanged, onError }: { documentId: string; comments: Comment[]; onChanged: () => Promise<void>; onError: (message: string | null) => void }) {
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = new Set(comments.map((c) => c.id));
  const childrenOf = (parent: string | null) => comments.filter((c) => (c.parentId && ids.has(c.parentId) ? c.parentId : null) === parent);

  const add = async () => {
    setBusy(true);
    onError(null);
    try {
      await run("library_comment_add", { documentId, body: body.trim(), parentId: replyTo?.id }, true);
      setBody("");
      setReplyTo(null);
      await onChanged();
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const render = (parent: string | null, depth: number) =>
    childrenOf(parent).map((c) => (
      <li key={c.id} className="kn-comment" style={{ marginLeft: Math.min(depth, 4) * 20 }}>
        <div className="kn-muted">
          {c.createdBy}, {when(c.createdAt)}
        </div>
        <p className="kn-wrap">{c.body}</p>
        <Button size="sm" variant="ghost" onClick={() => setReplyTo(c)}>
          Reply
        </Button>
        {render(c.id, depth + 1)}
      </li>
    ));

  return (
    <section aria-label="Comments">
      <h3 className="kn-section">Comments</h3>
      {comments.length ? <ul className="kn-list">{render(null, 0)}</ul> : <p className="kn-muted">No comments yet.</p>}
      <Field label={replyTo ? `Reply to ${replyTo.createdBy}` : "Add a comment"}>
        <textarea className="tb-textarea" rows={3} value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <div className="kn-row">
        <Button variant="primary" onClick={() => void add()} disabled={busy || !body.trim()}>
          {busy ? "Saving…" : replyTo ? "Post reply" : "Post comment"}
        </Button>
        {replyTo ? (
          <Button variant="ghost" onClick={() => setReplyTo(null)}>
            Cancel reply
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function EditDialog({
  open,
  doc,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  doc: DocResponse["document"];
  busy: boolean;
  onClose: () => void;
  onSave: (patch: { title: string; summary: string; body: string; status: Status; tags: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState(doc.title);
  const [summary, setSummary] = useState(doc.summary ?? "");
  const [body, setBody] = useState(doc.body);
  const [status, setStatus] = useState<Status>(doc.status);
  const [tags, setTags] = useState(doc.tags.join(", "));
  useEffect(() => {
    if (!open) return;
    setTitle(doc.title);
    setSummary(doc.summary ?? "");
    setBody(doc.body);
    setStatus(doc.status);
    setTags(doc.tags.join(", "));
  }, [open, doc]);
  return (
    <Dialog
      open={open}
      title="Edit document"
      size="lg"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !title.trim()}
            onClick={() => void onSave({ title: title.trim(), summary, body, status, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) })}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Field label="Title">
        <TextInput value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="Summary">
        <textarea className="tb-textarea" rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} />
      </Field>
      <Field label="Text">
        <textarea className="tb-textarea kn-mono" rows={12} value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <Field label="Status">
        <Select options={STATUS_OPTIONS} value={status} onChange={(event) => setStatus(event.target.value as Status)} />
      </Field>
      <Field label="Tags" hint="Separate tags with commas.">
        <TextInput value={tags} onChange={(event) => setTags(event.target.value)} />
      </Field>
    </Dialog>
  );
}
