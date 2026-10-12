// C69: crash-safe GBrain migrations, decision logic against an in-memory database double (runs in CI).
// The real-Postgres + process-kill simulation lives in gbrain-boot-pg.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { AbortedError, type BootStatus, type Lease, type LockSession, MIGRATIONS_RUNNING_EXIT_CODE, migrateCrashSafe, staleReason } from "../services/gbrain/migration-lock.ts";

interface Row {
  holderHost: string;
  holderPid: number;
  token: string;
  refreshedAtMs: number;
  ttlExpiresMs: number;
}

/** One Postgres server: an advisory lock owned by a session, the upstream lease row, and an up/down switch. */
class FakePg {
  advisory: FakeSession | null = null;
  lease: Row | null = null;
  down = false;
  sessions = 0;
  connect = async (): Promise<LockSession> => {
    if (this.down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    this.sessions++;
    return new FakeSession(this);
  };
  /** the upstream runner's acquire: only an absent or expired lease is taken */
  upstreamAcquire(host: string, pid: number): string | null {
    if (this.lease && this.lease.ttlExpiresMs > Date.now()) return null;
    const token = randomUUID();
    this.lease = { holderHost: host, holderPid: pid, token, refreshedAtMs: Date.now(), ttlExpiresMs: Date.now() + 3_600_000 };
    return token;
  }
  upstreamRelease(token: string): void {
    if (this.lease?.token === token) this.lease = null;
  }
}

class FakeSession implements LockSession {
  readonly pg: FakePg;
  closed = false;
  constructor(pg: FakePg) {
    this.pg = pg;
  }
  async tryAdvisoryLock(): Promise<boolean> {
    if (this.pg.advisory && this.pg.advisory !== this) return false;
    this.pg.advisory = this;
    return true;
  }
  async readLease(): Promise<Lease | null> {
    const r = this.pg.lease;
    if (!r) return null;
    return {
      holderHost: r.holderHost,
      holderPid: r.holderPid,
      token: r.token,
      refreshedAt: String(r.refreshedAtMs),
      refreshedAgeS: (Date.now() - r.refreshedAtMs) / 1000,
      ttlExpired: r.ttlExpiresMs < Date.now(),
    };
  }
  async deleteLease(l: Lease): Promise<boolean> {
    const r = this.pg.lease;
    if (this.pg.advisory !== this || !r || r.token !== l.token || String(r.refreshedAtMs) !== l.refreshedAt) return false;
    this.pg.lease = null;
    return true;
  }
  /** session end (also a dead holder's connection): the server releases the advisory lock */
  async close(): Promise<void> {
    this.closed = true;
    if (this.pg.advisory === this) this.pg.advisory = null;
  }
}

const HOST = "c0ffee000001";
const FAST = { waitMs: 60, staleAfterMs: 150, pollMs: 5, attentionMinMs: 20, attentionMaxMs: 40 };

function harness(pg: FakePg, run?: (signal: AbortSignal) => Promise<number>) {
  const events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const statuses: BootStatus[] = [];
  const stop = new AbortController();
  let runs = 0;
  const upstream = async (): Promise<number> => {
    runs++;
    const token = pg.upstreamAcquire(HOST, 4242);
    if (!token) return MIGRATIONS_RUNNING_EXIT_CODE;
    pg.upstreamRelease(token);
    return 0;
  };
  return {
    events,
    statuses,
    stop,
    runs: () => runs,
    go: (extra: Partial<typeof FAST> = {}) =>
      migrateCrashSafe({
        connect: pg.connect,
        run: run ?? upstream,
        host: HOST,
        log: (level, event, fields = {}) => events.push({ level, event, fields }),
        onStatus: (s) => statuses.push(s),
        signal: stop.signal,
        ...FAST,
        ...extra,
      }),
  };
}

const lease = (over: Partial<Lease>): Lease => ({ holderHost: "other", holderPid: 21, token: "t", refreshedAt: null, refreshedAgeS: 0, ttlExpired: false, ...over });

describe("staleReason", () => {
  test("expired TTL, own host, or no refresh for staleAfter → stale; a fresh foreign lease is live", () => {
    assert.equal(staleReason(lease({ ttlExpired: true }), HOST, 180_000), "ttl_expired");
    assert.equal(staleReason(lease({ holderHost: HOST }), HOST, 180_000), "same_host");
    assert.equal(staleReason(lease({ refreshedAgeS: 181 }), HOST, 180_000), "refresh_stale");
    assert.equal(staleReason(lease({ refreshedAgeS: 59 }), HOST, 180_000), null);
    assert.equal(staleReason(lease({ holderHost: null, refreshedAgeS: 59 }), HOST, 180_000), null);
  });
});

describe("migrateCrashSafe", () => {
  test("qa1 replay: a lease left by a killed container on another host is taken over with a log line", async () => {
    const pg = new FakePg();
    pg.lease = { holderHost: "ffdcf33f76ab", holderPid: 21, token: randomUUID(), refreshedAtMs: Date.now() - 600_000, ttlExpiresMs: Date.now() + 3_000_000 };
    assert.equal(pg.upstreamAcquire(HOST, 1), null, "upstream alone refuses (the crash loop)");
    const h = harness(pg);
    await h.go({ staleAfterMs: 180_000 });
    const takeover = h.events.find((e) => e.event === "migration_lock_takeover");
    assert.deepEqual(takeover?.fields, { reason: "refresh_stale", holderHost: "ffdcf33f76ab", holderPid: 21, lastRefreshAgeS: 600 });
    assert.equal(takeover?.level, "warn");
    assert.equal(h.runs(), 1);
    assert.equal(pg.lease, null);
    assert.equal(pg.advisory, null, "advisory lock released after the run");
  });

  test("a lease this container wrote before a restart is stale at once (same host, pid reuse safe)", async () => {
    const pg = new FakePg();
    pg.lease = { holderHost: HOST, holderPid: 21, token: randomUUID(), refreshedAtMs: Date.now(), ttlExpiresMs: Date.now() + 3_600_000 };
    const h = harness(pg);
    await h.go();
    assert.equal(h.events.find((e) => e.event === "migration_lock_takeover")?.fields.reason, "same_host");
    assert.equal(h.runs(), 1);
  });

  test("a live foreign holder is never stolen: wait, then needs_attention (no exit), then recover once it stops refreshing", async () => {
    const pg = new FakePg();
    pg.lease = { holderHost: "live-0.1.8", holderPid: 7, token: randomUUID(), refreshedAtMs: Date.now(), ttlExpiresMs: Date.now() + 3_600_000 };
    const refresher = setInterval(() => {
      if (pg.lease) pg.lease.refreshedAtMs = Date.now();
    }, 10);
    const h = harness(pg);
    const done = h.go();
    await new Promise((r) => setTimeout(r, 150));
    const attention = h.statuses.find((s) => s.status === "needs_attention");
    assert.ok(attention && attention.status === "needs_attention");
    assert.equal(attention.reason, "migration_lock_held");
    assert.equal(attention.detail.holderHost, "live-0.1.8");
    assert.equal(h.runs(), 0, "nothing ran while the holder was alive");
    assert.ok(h.statuses.some((s) => s.status === "starting" && s.phase === "waiting"), "starting/waiting before the bound");
    clearInterval(refresher); // the holder dies: its refreshes stop
    await done;
    assert.equal(h.runs(), 1);
    assert.equal(h.events.find((e) => e.event === "migration_lock_takeover")?.fields.reason, "refresh_stale");
    assert.ok(h.events.some((e) => e.event === "needs_attention_cleared"));
  });

  test("runners are serialised by the advisory lock; a dead runner's session frees it", async () => {
    const pg = new FakePg();
    const other = (await pg.connect()) as FakeSession;
    assert.equal(await other.tryAdvisoryLock(), true);
    // the other runner's upstream lease is fresh and on another host: it must not be touched
    pg.lease = { holderHost: "peer", holderPid: 9, token: randomUUID(), refreshedAtMs: Date.now(), ttlExpiresMs: Date.now() + 3_600_000 };
    const h = harness(pg);
    const done = h.go({ waitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(h.runs(), 0);
    assert.equal(h.statuses.at(-1)?.status, "starting");
    // the peer container is killed: its connection closes (lock freed); its lease stays, unrefreshed
    await other.close();
    await done;
    assert.equal(h.runs(), 1);
    assert.equal(pg.lease, null);
  });

  test("a failed migration run is needs_attention at once and retried with backoff (no process exit)", async () => {
    const pg = new FakePg();
    let calls = 0;
    const h = harness(pg, async () => (++calls < 3 ? 1 : 0));
    await h.go({ waitMs: 10_000 });
    assert.equal(calls, 3);
    const failed = h.statuses.filter((s) => s.status === "needs_attention");
    assert.equal(failed.length, 2);
    assert.ok(failed.every((s) => s.status === "needs_attention" && s.reason === "migrations_failed" && s.detail.exitCode === 1));
  });

  test("exit 75 (an old runner took the lease between takeover and acquire) is a busy lock, retried", async () => {
    const pg = new FakePg();
    let calls = 0;
    const h = harness(pg, async () => (++calls === 1 ? MIGRATIONS_RUNNING_EXIT_CODE : 0));
    await h.go();
    assert.equal(calls, 2);
    assert.ok(h.statuses.some((s) => s.status === "starting" && s.reason === "migration_lock_held"));
  });

  test("an unreachable database waits, then needs_attention database_unreachable, then recovers", async () => {
    const pg = new FakePg();
    pg.down = true;
    const h = harness(pg);
    const done = h.go();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(h.statuses.some((s) => s.status === "needs_attention" && s.reason === "database_unreachable" && s.detail.code === "ECONNREFUSED"));
    pg.down = false;
    await done;
    assert.equal(h.runs(), 1);
  });

  test("a stop signal during the run: the runner is stopped, its lease removed, the lock released, AbortedError", async () => {
    const pg = new FakePg();
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const h = harness(pg, (signal) => {
      // a runner killed without cleaning up (SIGKILL after the grace period)
      pg.upstreamAcquire(HOST, 77);
      started();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(137), { once: true }));
    });
    const done = h.go();
    await running;
    assert.ok(pg.lease);
    h.stop.abort();
    await assert.rejects(done, AbortedError);
    assert.equal(pg.lease, null);
    assert.equal(pg.advisory, null);
    assert.equal(h.events.find((e) => e.event === "migration_lock_released")?.fields.exitCode, 137);
  });
});
