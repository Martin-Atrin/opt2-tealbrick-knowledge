// C69: crash-safe GBrain migrations (Knowledge wrapper; upstream GBrain unmodified).
//
// Upstream `gbrain apply-migrations` (garrytan/gbrain 99de5707, src/core/migration-orchestration-lock.ts) holds a
// renewable lease row `gbrain_cycle_locks.id = 'gbrain-apply-migrations'` (60 min TTL, refreshed every 60 s). It takes
// over a lease only after the TTL or when the holder is a provably dead pid on the SAME host, so a container killed
// mid-migration blocks every later container (new hostname) for up to an hour with exit 75.
//
// This wrapper serialises Knowledge's migration runners with a Postgres session-level advisory lock (released by the
// server when the holder's connection dies) and, while holding it, removes an upstream lease that no live runner can
// own: expired, written by this container before its runner started, or not refreshed for `staleAfterMs`. A wait never
// ends in an endless crash loop: after `waitMs` the status turns `needs_attention` (with a reason) and attempts continue
// with backoff in the same process.

/** pg_advisory_lock key of Knowledge's GBrain migration runner (arbitrary constant, unique within the gbrain DB). */
export const ADVISORY_LOCK_KEY = "7431202610120001";
/** Upstream lease id (gbrain src/core/migration-orchestration-lock.ts MIGRATION_ORCHESTRATION_LOCK_ID). */
export const UPSTREAM_LEASE_ID = "gbrain-apply-migrations";
/** Upstream exit status "another apply-migrations is running" (gbrain src/core/exit-codes.ts). */
export const MIGRATIONS_RUNNING_EXIT_CODE = 75;

export interface Lease {
  holderHost: string | null;
  holderPid: number | null;
  /** acquisition_token: the delete is fenced on it */
  token: string;
  /** last_refreshed_at as Postgres text (exact round trip): the delete is fenced on it too */
  refreshedAt: string | null;
  /** seconds since the last refresh (or acquisition when never refreshed), measured by the database clock */
  refreshedAgeS: number;
  ttlExpired: boolean;
}

/** One database session. Closing it (or the process dying) releases the advisory lock. */
export interface LockSession {
  tryAdvisoryLock(): Promise<boolean>;
  /** The upstream lease, or null when there is none (also when the schema has no lease table yet). */
  readLease(): Promise<Lease | null>;
  /** Deletes exactly the inspected lease (same token and refresh time) while this session still holds the advisory lock. */
  deleteLease(lease: Lease): Promise<boolean>;
  close(): Promise<void>;
}

export type StaleReason = "ttl_expired" | "same_host" | "refresh_stale";

/**
 * Only called while holding the advisory lock, so no other Knowledge runner is active. A lease is stale when:
 * - its TTL lapsed (upstream would take it over itself), or
 * - it names this container's host: this container's runner has not started yet, so the writer is dead, or
 * - it was not refreshed for `staleAfterMs`: a live upstream runner refreshes every 60 s.
 */
export function staleReason(lease: Lease, host: string, staleAfterMs: number): StaleReason | null {
  if (lease.ttlExpired) return "ttl_expired";
  if (lease.holderHost !== null && lease.holderHost === host) return "same_host";
  if (lease.refreshedAgeS * 1000 >= staleAfterMs) return "refresh_stale";
  return null;
}

export type AttentionReason = "migration_lock_held" | "database_unreachable" | "migrations_failed";

export type BootStatus =
  | { status: "starting"; phase: "migrations" | "waiting" | "serve"; reason?: AttentionReason; detail?: Record<string, unknown> }
  | { status: "needs_attention"; reason: AttentionReason; detail: Record<string, unknown>; since: string; nextAttemptInS: number };

export type Log = (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;

export interface MigrateOptions {
  connect: () => Promise<LockSession>;
  /** Runs init (when needed) + `gbrain apply-migrations` as a child; returns its exit code. Must stop the child on `signal`. */
  run: (signal: AbortSignal) => Promise<number>;
  host: string;
  log: Log;
  onStatus: (status: BootStatus) => void;
  signal: AbortSignal;
  /** wait for a busy lock / unreachable DB before `needs_attention` (default 240 s: inside Railway's 300 s healthcheck) */
  waitMs?: number;
  /** an upstream lease not refreshed for this long has no live holder (default 180 s = 3 missed refreshes) */
  staleAfterMs?: number;
  /** poll interval while waiting (default 2 s) */
  pollMs?: number;
  /** backoff in needs_attention: first and maximum delay (defaults 30 s, 300 s) */
  attentionMinMs?: number;
  attentionMaxMs?: number;
}

type Attempt = { kind: "done" } | { kind: "busy" | "failed"; reason: AttentionReason; detail: Record<string, unknown> };

export class AbortedError extends Error {
  constructor() {
    super("stopped");
    this.name = "AbortedError";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "error";
}

function leaseFields(lease: Lease): Record<string, unknown> {
  return { holderHost: lease.holderHost, holderPid: lease.holderPid, lastRefreshAgeS: Math.round(lease.refreshedAgeS) };
}

async function attempt(o: MigrateOptions, staleAfterMs: number): Promise<Attempt> {
  let s: LockSession;
  try {
    s = await o.connect();
  } catch (e) {
    return { kind: "busy", reason: "database_unreachable", detail: { code: errorCode(e) } };
  }
  try {
    if (!(await s.tryAdvisoryLock())) return { kind: "busy", reason: "migration_lock_held", detail: { holder: "another Knowledge migration runner" } };
    const lease = await s.readLease();
    if (lease) {
      const reason = staleReason(lease, o.host, staleAfterMs);
      if (!reason) return { kind: "busy", reason: "migration_lock_held", detail: leaseFields(lease) };
      if (!(await s.deleteLease(lease))) return { kind: "busy", reason: "migration_lock_held", detail: { ...leaseFields(lease), takeover: "raced" } };
      o.log("warn", "migration_lock_takeover", { reason, ...leaseFields(lease) });
    }
    o.onStatus({ status: "starting", phase: "migrations" });
    const code = await o.run(o.signal);
    // The runner is gone (finished, failed or stopped): a lease it left on this host has no holder any more.
    const left = await s.readLease().catch(() => null);
    if (left && left.holderHost === o.host && (await s.deleteLease(left).catch(() => false))) {
      o.log("warn", "migration_lock_released", { reason: "runner_exited", exitCode: code, holderPid: left.holderPid });
    }
    if (code === 0) return { kind: "done" };
    if (o.signal.aborted) throw new AbortedError();
    if (code === MIGRATIONS_RUNNING_EXIT_CODE) return { kind: "busy", reason: "migration_lock_held", detail: { exitCode: code } };
    return { kind: "failed", reason: "migrations_failed", detail: { exitCode: code } };
  } catch (e) {
    if (e instanceof AbortedError || o.signal.aborted) throw new AbortedError();
    return { kind: "busy", reason: "database_unreachable", detail: { code: errorCode(e) } };
  } finally {
    await s.close().catch(() => {});
  }
}

/**
 * Resolves once migrations succeeded. Never exits the process: a busy lock or an unreachable database is retried every
 * `pollMs` for `waitMs`, then (and at once for a failed migration run) the status is `needs_attention` and attempts
 * continue with backoff. Rejects only with AbortedError when `signal` aborts (after the runner and its lease are cleaned up).
 */
export async function migrateCrashSafe(o: MigrateOptions): Promise<void> {
  const waitMs = o.waitMs ?? 240_000;
  const staleAfterMs = o.staleAfterMs ?? 180_000;
  const pollMs = o.pollMs ?? 2_000;
  const minMs = o.attentionMinMs ?? 30_000;
  const maxMs = o.attentionMaxMs ?? 300_000;
  const start = Date.now();
  let delay = minMs;
  let attention: { reason: AttentionReason; since: string } | null = null;
  let lastBusy: AttentionReason | null = null;
  for (;;) {
    if (o.signal.aborted) throw new AbortedError();
    const r = await attempt(o, staleAfterMs);
    if (r.kind === "done") {
      if (attention) o.log("info", "needs_attention_cleared", { reason: attention.reason });
      return;
    }
    if (r.kind === "busy" && !attention && Date.now() - start < waitMs) {
      if (lastBusy !== r.reason) o.log("info", "migrations_waiting", { reason: r.reason, ...r.detail });
      lastBusy = r.reason;
      o.onStatus({ status: "starting", phase: "waiting", reason: r.reason, detail: r.detail });
      await sleep(pollMs, o.signal);
      continue;
    }
    if (!attention || attention.reason !== r.reason) attention = { reason: r.reason, since: new Date().toISOString() };
    o.log("error", "needs_attention", { reason: r.reason, ...r.detail, nextAttemptInS: Math.round(delay / 1000) });
    o.onStatus({ status: "needs_attention", reason: r.reason, detail: r.detail, since: attention.since, nextAttemptInS: Math.round(delay / 1000) });
    await sleep(delay, o.signal);
    delay = Math.min(delay * 2, maxMs);
  }
}
