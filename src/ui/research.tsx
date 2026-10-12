// Research page: per area, the sources and notes held by the research engine. Read, and remove sources.
import { Button, Field, Notice, Select, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDelete, ErrorNotice, errText, run, TextBlock, useOverview, when } from "./common.tsx";

interface ResearchResponse {
  enabled: boolean;
  sources: { id: string; title: string; updated: string | number }[];
  notes: { id: string; title: string; noteType: string; updated: string | number }[];
}
type Item =
  | { id: string; title: string; updated: string | number; fullText: string }
  | { id: string; title: string; updated: string | number; content: string };

const itemText = (item: Item) => ("fullText" in item ? item.fullText : item.content);

export function Research() {
  const { areas, error: overviewError } = useOverview();
  const [area, setArea] = useState("");
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [item, setItem] = useState<{ kind: "source" | "note"; value: Item } | null>(null);
  const [toDelete, setToDelete] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!area && areas?.length) setArea((areas.find((a) => a.researchReady) ?? areas[0])?.id ?? "");
  }, [areas, area]);

  const load = useCallback(async () => {
    if (!area) return;
    try {
      setData(await run<ResearchResponse>("library_research", { area }));
      setError(null);
    } catch (e) {
      setData(null);
      setError(errText(e));
    }
  }, [area]);
  useEffect(() => {
    setItem(null);
    setData(null);
    void load();
  }, [load]);

  const open = async (kind: "source" | "note", id: string) => {
    setError(null);
    try {
      setItem({ kind, value: await run<Item>("library_research_item", { area, id }) });
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeSource = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      await run("library_research_source_delete", { area, id: toDelete.id });
      if (item?.kind === "source" && item.value.id === toDelete.id) setItem(null);
      setToDelete(null);
      await load();
    } catch (e) {
      setError(errText(e));
      setToDelete(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Field label="Memory area">
        <Select options={(areas ?? []).map((a) => ({ value: a.id, label: a.label }))} value={area} onChange={(event) => setArea(event.target.value)} />
      </Field>
      <ErrorNotice error={overviewError ?? error} />
      {data && !data.enabled ? <Notice tone="action">Research is not set up for this area.</Notice> : null}
      {data?.enabled ? (
        <div className="kn-split kn-section">
          <div>
            <h3>Sources</h3>
            {data.sources.length ? (
              <ul className="kn-list">
                {data.sources.map((s) => (
                  <li key={s.id} className="kn-row">
                    <button type="button" className="kn-link" onClick={() => void open("source", s.id)}>
                      {s.title || "Untitled"}
                    </button>
                    <span className="kn-muted">{when(s.updated)}</span>
                    <Button size="sm" variant="ghost" aria-label={`Remove source ${s.title || "Untitled"}`} onClick={() => setToDelete({ id: s.id, title: s.title })}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kn-muted">No sources yet.</p>
            )}
            <h3 className="kn-section">Notes</h3>
            {data.notes.length ? (
              <ul className="kn-list">
                {data.notes.map((n) => (
                  <li key={n.id} className="kn-row">
                    <button type="button" className="kn-link" onClick={() => void open("note", n.id)}>
                      {n.title || "Untitled"}
                    </button>
                    <Tag tone="neutral">{n.noteType}</Tag>
                    <span className="kn-muted">{when(n.updated)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kn-muted">No notes yet.</p>
            )}
          </div>
          <section aria-label="Selected item">
            {item ? (
              <div>
                <div className="kn-row">
                  <strong>{item.value.title || "Untitled"}</strong>
                  <Tag tone="neutral">{item.kind}</Tag>
                  <Button size="sm" variant="ghost" onClick={() => setItem(null)}>
                    Close
                  </Button>
                </div>
                <p className="kn-muted">Updated {when(item.value.updated)}</p>
                <TextBlock text={itemText(item.value)} label={`Text of ${item.kind}`} />
              </div>
            ) : (
              <p className="kn-muted">Choose a source or a note to read it.</p>
            )}
          </section>
        </div>
      ) : null}
      <ConfirmDelete
        open={toDelete !== null}
        title="Remove source"
        what={
          <>
            the source <strong>{toDelete?.title || "Untitled"}</strong>
          </>
        }
        busy={busy}
        onConfirm={() => void removeSource()}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}
