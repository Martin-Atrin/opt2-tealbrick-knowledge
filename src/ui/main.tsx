// Knowledge person UI: Configure (who may read/write which memory area), indexing status, holds, keys.
import { callOp, TbProvider, tbFetch, useAgents, useHolds, useScopes, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, BrandMark, Button, Notice, Select, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Library, type LibraryNav } from "./library.tsx";
import { Recall } from "./recall.tsx";
import { Research } from "./research.tsx";


interface AreaStatus {
  id: string;
  label: string;
  kind: "agent" | "shared";
  engineReady: boolean;
  researchReady: boolean;
  pending: number;
  ready: number;
  failed: number;
}

function useAreas() {
  const [areas, setAreas] = useState<AreaStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    callOp<{ areas: AreaStatus[] }>("indexing_status", {})
      .then((r) => setAreas(r.areas))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not load areas"));
  }, []);
  useEffect(reload, [reload]);
  return { areas, error, reload };
}

const ACCESS_OPTIONS = [
  { value: "", label: "No access" },
  { value: "read", label: "Read" },
  { value: "read_write", label: "Read and write" },
];

function Configure({ areas }: { areas: AreaStatus[] }) {
  const { agents, loading } = useAgents();
  const { access, set } = useScopes();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (loading) return <p className="kn-muted">Loading agents…</p>;
  if (!agents.length) return <Notice tone="action">No agent is connected to Knowledge yet. Draw a line from an agent to Knowledge on the canvas.</Notice>;
  const level = (agent: string, area: string) => access.find((row) => row.agent === agent && row.type === "area" && row.instanceId === area)?.access ?? "";
  const change = async (agent: string, area: string, value: string) => {
    setBusy(`${agent}|${area}`);
    setError(null);
    try {
      await set(agent as never, "area", area, value === "" ? null : value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <p className="kn-muted">Each agent has its own memory area. Everyone can read the company area; turn on "Read and write" to let an agent add company knowledge.</p>
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <table className="kn-table">
        <thead>
          <tr>
            <th>Agent</th>
            {areas.map((area) => (
              <th key={area.id}>{area.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <td>
                {agent.name} {agent.status === "paused" ? <Tag tone="blocked">paused</Tag> : null}
              </td>
              {areas.map((area) => (
                <td key={area.id}>
                  <Select
                    aria-label={`${agent.name} access to ${area.label}`}
                    options={ACCESS_OPTIONS}
                    value={level(agent.id, area.id)}
                    disabled={busy === `${agent.id}|${area.id}`}
                    onChange={(event) => void change(agent.id, area.id, event.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Status({ areas, reload }: { areas: AreaStatus[]; reload: () => void }) {
  return (
    <div>
      <div className="kn-row">
        <Button size="sm" onClick={reload}>
          Refresh
        </Button>
      </div>
      <table className="kn-table kn-section">
        <thead>
          <tr>
            <th>Area</th>
            <th>Memory engine</th>
            <th>Documents in memory</th>
            <th>Waiting</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => (
            <tr key={area.id}>
              <td>{area.label}</td>
              <td>{area.engineReady ? <Tag tone="ok">ready</Tag> : <Tag tone="progress">preparing</Tag>}</td>
              <td>{area.ready}</td>
              <td>{area.pending}</td>
              <td>{area.failed ? <Tag tone="blocked">{area.failed}</Tag> : 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Holds() {
  const { holds, loading, decide } = useHolds({ status: "held" });
  if (loading) return <p className="kn-muted">Loading…</p>;
  if (!holds.length) return <p className="kn-muted">Nothing waits for your approval.</p>;
  return (
    <table className="kn-table">
      <tbody>
        {holds.map((hold) => (
          <tr key={hold.id}>
            <td>
              <strong>{hold.caller.name}</strong>: {hold.view ?? hold.summary}
            </td>
            <td className="kn-row">
              <Button size="sm" variant="primary" onClick={() => void decide(hold.id as never, "approve")}>
                Approve
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void decide(hold.id as never, "deny")}>
                Deny
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Keys() {
  const [keys, setKeys] = useState<{ name: string; required: boolean; present: boolean; source: string | null }[]>([]);
  useEffect(() => {
    callOp<typeof keys | { keys: typeof keys }>("tb.keys_status", {})
      .then((r) => setKeys(Array.isArray(r) ? r : r.keys))
      .catch(() => setKeys([]));
  }, []);
  return (
    <div>
      <p className="kn-muted">Model keys are entered on the bridge key page (open it from Portal). Knowledge never shows key values.</p>
      <table className="kn-table">
        <tbody>
          {keys.map((key) => (
            <tr key={key.name}>
              <td>{key.name}</td>
              <td>{key.present ? <Tag tone="ok">present</Tag> : key.required ? <Tag tone="action">needed</Tag> : <Tag tone="neutral">not needed</Tag>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ReceiptRow {
  id: string;
  caller: { name: string };
  op: string;
  status: string;
  summary: string;
  createdAt: number;
}

function Receipts() {
  const [items, setItems] = useState<ReceiptRow[]>([]);
  useEffect(() => {
    callOp<{ items: ReceiptRow[] }>("tb.receipts_list", {})
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  if (!items.length) return <p className="kn-muted">No agent actions recorded yet.</p>;
  return (
    <table className="kn-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Agent</th>
          <th>Action</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{new Date(item.createdAt).toLocaleString()}</td>
            <td>{item.caller.name}</td>
            <td>{item.summary || item.op}</td>
            <td>
              <Tag tone={item.status === "run" || item.status === "approved" ? "ok" : item.status === "held" ? "action" : "neutral"}>{item.status}</Tag>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}


function Backups() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await tbFetch("tb/v1/ops/tb.export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
      const name = /filename="([^"]+)"/u.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "knowledge-export.tar.gz";
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "export failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="kn-muted">Backups run every night inside your deployment (documents, memory engine and research databases). The export is a readable copy of your documents and agent receipts.</p>
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <Button onClick={() => void download()} disabled={busy}>
        {busy ? "Preparing…" : "Download a copy"}
      </Button>
    </div>
  );
}

/** Own pages first, then the SDK standard pages; "Agents & scopes" is Knowledge's area access table. */
const PAGES = [{ id: "library", label: "Library" }, { id: "recall", label: "Recall" }, { id: "research", label: "Research" }, { id: "status", label: "Memory status" }, ...STANDARD_PAGES];

function initialPage(): string {
  const rest = window.location.pathname.replace(/^\/a\/knowledge\/?/u, "");
  if (rest.startsWith("configure")) return "agents";
  return PAGES.some((page) => page.id === rest) ? rest : "library";
}

function App() {
  const { status } = useSession();
  const [page, setPage] = useState(initialPage);
  const [library, setLibrary] = useState<LibraryNav>({ area: "", collectionId: "", documentId: "" });
  const patchLibrary = useCallback((patch: Partial<LibraryNav>) => setLibrary((prev) => ({ ...prev, ...patch })), []);
  const openDocument = useCallback((documentId: string) => {
    setLibrary((prev) => ({ ...prev, documentId }));
    setPage("library");
  }, []);
  const { areas, error, reload } = useAreas();
  const { holds } = useHolds({ status: "held" });
  if (status === "loading") return <p className="kn-muted">Loading…</p>;
  if (status === "signed_out") return <Notice tone="action">Your session ended. Open Knowledge again from the Portal canvas.</Notice>;
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.length || null } : p));
  return (
    <AppShell title="Knowledge" icon={<BrandMark size={22} />} pages={pages} current={page} onNavigate={setPage}>
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      {page === "library" ? <Library nav={library} setNav={patchLibrary} /> : null}
      {page === "recall" ? <Recall onOpen={openDocument} /> : null}
      {page === "research" ? <Research /> : null}
      {page === "agents" ? <Configure areas={areas} /> : null}
      {page === "status" ? <Status areas={areas} reload={reload} /> : null}
      {page === "holds" ? <Holds /> : null}
      {page === "receipts" ? <Receipts /> : null}
      {page === "keys" ? <Keys /> : null}
      {page === "backups" ? <Backups /> : null}
    </AppShell>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <TbProvider product="knowledge">
        <App />
      </TbProvider>
    </StrictMode>,
  );
}
