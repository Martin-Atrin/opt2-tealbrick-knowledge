// Shared helpers for the owner pages (Library, Recall, Research): error text, debounce, op calls, delete confirmation.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Notice } from "@opt2-tealbrick/ui";
import { type ReactNode, useEffect, useState } from "react";

export type Status = "draft" | "published" | "archived";
type Value = string | number | boolean | string[];

/** Drop undefined values so optional op inputs stay out of the request. */
export function input(fields: Record<string, Value | undefined>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
}

export const run = <O,>(op: string, fields: Record<string, Value | undefined> = {}, create = false) =>
  callOp<O>(op, input(fields), create ? { idempotencyKey: crypto.randomUUID() } : undefined);

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export function isConflict(e: unknown): boolean {
  return e instanceof Error && (e as { code?: unknown }).code === "version_conflict";
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function ErrorNotice({ error }: { error: string | null }) {
  return error ? (
    <Notice tone="action" role="alert">
      {error}
    </Notice>
  ) : null;
}

export const when = (ms: number | string | null | undefined) => (ms ? new Date(ms).toLocaleString() : "");

export function statusTone(status: string) {
  return status === "published" ? "ok" : status === "draft" ? "progress" : "neutral";
}

/** Confirmation before any delete. `what` completes "This removes ...". */
export function ConfirmDelete({
  open,
  title,
  what,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  what: ReactNode;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        </>
      }
    >
      <p>
        This removes {what} from memory search. It cannot be undone from here.
      </p>
    </Dialog>
  );
}

/** Untrusted text shown as preformatted, wrapping text. Never HTML. */
export function TextBlock({ text, label }: { text: string; label: string }) {
  return (
    <section aria-label={label}>
      <pre className="kn-pre">{text}</pre>
    </section>
  );
}

/** Area picker used by Library, Recall and Research. */
export interface AreaOption {
  id: string;
  label: string;
  kind: "agent" | "shared";
  documents?: number;
  collections?: number;
  engineReady: boolean;
  researchReady: boolean;
}

export function useOverview() {
  const [areas, setAreas] = useState<AreaOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    run<{ areas: AreaOption[] }>("library_overview")
      .then((r) => setAreas(r.areas))
      .catch((e: unknown) => setError(errText(e)));
  }, []);
  return { areas, error };
}
