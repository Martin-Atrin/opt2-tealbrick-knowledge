// Recall page: ask memory a question the way an agent would, optionally within one area. A result opens in Library.
import { Button, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { type FormEvent, useState } from "react";
import { ErrorNotice, errText, run, useOverview } from "./common.tsx";

interface RecallResponse {
  results: { documentId: string; title: string; text: string; areas: string[] }[];
  areas: { area: string; ok: boolean; via: "engine" | "keyword"; error?: string }[];
  degraded: boolean;
}

export function Recall({ onOpen }: { onOpen: (documentId: string) => void }) {
  const { areas, error: overviewError } = useOverview();
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("");
  const [answer, setAnswer] = useState<RecallResponse | null>(null);
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (id: string) => areas?.find((a) => a.id === id)?.label ?? id;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await run<RecallResponse>("library_recall", { query: text, area: area || undefined, limit: 20 }));
      setAsked(text);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const failed = answer?.areas.filter((a) => !a.ok) ?? [];
  return (
    <div>
      <p className="kn-muted">Search memory the way an agent does. Results come from the memory engine; when it is not ready, a keyword search answers instead.</p>
      <ErrorNotice error={overviewError ?? error} />
      <form className="kn-row kn-form" onSubmit={(event) => void submit(event)}>
        <Field label="Question or keywords">
          <TextInput value={query} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <Field label="Memory area">
          <Select options={[{ value: "", label: "All areas" }, ...(areas ?? []).map((a) => ({ value: a.id, label: a.label }))]} value={area} onChange={(event) => setArea(event.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search memory"}
        </Button>
      </form>
      {answer ? (
        <div className="kn-section" aria-live="polite">
          {answer.degraded ? <Notice tone="action">Degraded: keyword search only. The memory engine did not answer for every area.</Notice> : null}
          {failed.map((a) => (
            <Notice key={a.area} tone="action">
              {label(a.area)}: {a.error ?? "no answer"}
            </Notice>
          ))}
          {answer.results.length ? (
            <ul className="kn-list">
              {answer.results.map((r) => (
                <li key={`${r.documentId}`} className="kn-result">
                  <div className="kn-row">
                    <button type="button" className="kn-link" onClick={() => onOpen(r.documentId)}>
                      {r.title || "Untitled"}
                    </button>
                    {r.areas.map((id) => (
                      <Tag key={id} tone="neutral">
                        {label(id)}
                      </Tag>
                    ))}
                  </div>
                  <p className="kn-wrap kn-clip">{r.text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kn-muted">Nothing in memory matches "{asked}".</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
