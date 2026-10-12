// C69: the LockSession of migration-lock.ts over one dedicated Postgres connection (postgres.js, max 1, never recycled).
// postgres.js silently reconnects after a dropped connection; a new connection is a new session WITHOUT the advisory
// lock, so every lease delete is fenced on the backend pid that took the lock. The refresh time is compared as text:
// postgres.js would send a timestamptz parameter through Date and drop the microseconds.
import postgres from "postgres";
import { ADVISORY_LOCK_KEY, type Lease, type LockSession, UPSTREAM_LEASE_ID } from "./migration-lock.ts";

export interface PgOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectTimeoutS?: number;
}

/** A schema without the upstream lease table / columns yet has no lease (upstream treats it the same way). */
function isMissingLeaseSchema(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42703";
}

export async function connectPg(o: PgOptions): Promise<LockSession> {
  const sql = postgres({
    host: o.host,
    port: o.port,
    user: o.user,
    password: o.password,
    database: o.database,
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    connect_timeout: o.connectTimeoutS ?? 10,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: "knowledge-gbrain-migrations" },
  });
  let lockPid: number | null = null;
  try {
    // Server-side keepalives: a holder whose host vanished without closing TCP loses the lock within ~1 min.
    await sql`SELECT set_config('tcp_keepalives_idle', '30', false), set_config('tcp_keepalives_interval', '10', false), set_config('tcp_keepalives_count', '3', false)`;
  } catch (e) {
    await sql.end({ timeout: 1 }).catch(() => {});
    throw e;
  }
  return {
    async tryAdvisoryLock() {
      const rows = await sql<{ locked: boolean; pid: number }[]>`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}::bigint) AS locked, pg_backend_pid() AS pid`;
      const row = rows[0];
      if (row?.locked) lockPid = row.pid;
      return row?.locked === true;
    },
    async readLease() {
      try {
        const rows = await sql<{ holder_pid: number | null; holder_host: string | null; token: string; refreshed_at: string | null; refreshed_age_s: number; ttl_expired: boolean }[]>`
          SELECT holder_pid, holder_host, acquisition_token::text AS token, last_refreshed_at::text AS refreshed_at,
                 EXTRACT(EPOCH FROM (now() - COALESCE(last_refreshed_at, acquired_at)))::float8 AS refreshed_age_s,
                 (ttl_expires_at < now()) AS ttl_expired
            FROM gbrain_cycle_locks WHERE id = ${UPSTREAM_LEASE_ID}`;
        const r = rows[0];
        if (!r) return null;
        return { holderHost: r.holder_host, holderPid: r.holder_pid, token: r.token, refreshedAt: r.refreshed_at, refreshedAgeS: Number(r.refreshed_age_s), ttlExpired: r.ttl_expired === true };
      } catch (e) {
        if (isMissingLeaseSchema(e)) return null;
        throw e;
      }
    },
    async deleteLease(lease: Lease) {
      if (lockPid === null) return false;
      const rows = await sql`
        DELETE FROM gbrain_cycle_locks
         WHERE id = ${UPSTREAM_LEASE_ID} AND acquisition_token = ${lease.token}::uuid
           AND last_refreshed_at::text IS NOT DISTINCT FROM ${lease.refreshedAt}::text
           AND pg_backend_pid() = ${lockPid}
        RETURNING id`;
      return rows.length === 1;
    },
    async close() {
      await sql.end({ timeout: 2 });
    },
  };
}

export function pgOptionsFromEnv(env: Record<string, string | undefined>): PgOptions {
  const host = env.GBRAIN_DB_HOST;
  const password = env.GBRAIN_DB_PASSWORD;
  if (!host || !password) throw new Error("GBRAIN_DB_HOST and GBRAIN_DB_PASSWORD are required");
  // Same database as entrypoint.sh's GBRAIN_DATABASE_URL (postgres@<host>:5432/gbrain); the overrides exist for tests.
  return { host, password, port: Number(env.GBRAIN_DB_PORT ?? 5432), user: env.GBRAIN_DB_USER ?? "postgres", database: env.GBRAIN_DB_NAME ?? "gbrain" };
}
