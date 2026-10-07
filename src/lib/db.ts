import { neon, Pool as NeonPool } from '@neondatabase/serverless';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- row shapes vary by query
type QueryRow = Record<string, any>;

type Queryable = {
  query: <T = QueryRow>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

export type Client = Queryable & { release: () => void };

type PoolLike = Queryable & {
  connect: () => Promise<Client>;
  end: () => Promise<void>;
};

const globalDb = globalThis as unknown as {
  festivalHttpSql?: ReturnType<typeof neon>;
  festivalPgPool?: import('pg').Pool;
};

function loadLocalEnv() {
  if (typeof process === 'undefined') return;
  try {
    // Fill missing vars from .env.local; do not override Worker/runtime secrets.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config } = require('dotenv') as typeof import('dotenv');
    // ENV_FILE selects the environment for operator scripts (e.g. .env.production).
    config({ path: process.env.ENV_FILE || '.env.local', quiet: true });
  } catch {
    // dotenv unavailable in some edge builds
  }
}

loadLocalEnv();

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

function isNeonUrl(url: string) {
  return url.includes('neon.tech');
}

function prefersNeonHttp() {
  return isNeonUrl(process.env.DATABASE_URL || '');
}

function getHttpSql() {
  if (!globalDb.festivalHttpSql) {
    globalDb.festivalHttpSql = neon(connectionString(), {
      fetchOptions: { cache: 'no-store' },
    });
  }
  return globalDb.festivalHttpSql;
}

async function getPgPool() {
  if (!globalDb.festivalPgPool) {
    const pg = await import('pg');
    globalDb.festivalPgPool = new pg.default.Pool({
      connectionString: connectionString(),
      max: Number(process.env.DB_POOL_MAX ?? 5),
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 20000,
    });
  }
  return globalDb.festivalPgPool;
}

/**
 * Upper bound for one Neon HTTP query. Without it a stalled fetch hangs the
 * request (and a cron tick) indefinitely. It must exceed a Neon cold start
 * (compute waking from scale-to-zero, ~1–5 s) and the longest lock wait a
 * statement can see (withSerialLock's 20 s lock_timeout).
 */
export const DB_QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS ?? 25000);

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  // The Neon driver wraps fetch failures in NeonDbError with the cause in sourceError.
  return isTimeout((error as { sourceError?: unknown }).sourceError);
}

async function withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      // A timed-out statement may still run on the server: never send it twice.
      if (attempt === attempts - 1 || isTimeout(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw last;
}

function wrapClient(client: Queryable, release: () => void): Client {
  return {
    query: (sql, values = []) => client.query(sql, values),
    release,
  };
}

export async function query<T = QueryRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  if (prefersNeonHttp()) {
    const rows = await withRetry(() =>
      getHttpSql().query(sql, values, { fetchOptions: { signal: AbortSignal.timeout(DB_QUERY_TIMEOUT_MS) } }),
    );
    return rows as T[];
  }
  const pool = await getPgPool();
  return (await pool.query(sql, values)).rows as T[];
}

export async function transaction<T>(fn: (client: Client) => Promise<T>, commerce = false): Promise<T> {
  if (prefersNeonHttp()) {
    const pool = new NeonPool({ connectionString: connectionString(), max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '10s'");
      if (commerce) await client.query("SELECT pg_advisory_xact_lock(hashtext('festival-commerce'))");
      const result = await fn(wrapClient(client, () => client.release()));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection may already be dead.
      }
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }

  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    if (commerce) await client.query("SELECT pg_advisory_xact_lock(hashtext('festival-commerce'))");
    const result = await fn(wrapClient(client, () => client.release()));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Serialises a critical section per key across processes, including external
 * HTTP calls made inside it. Uses a TRANSACTION-scoped advisory lock inside an
 * explicit transaction: a pooler in transaction mode (Neon's pooled URL,
 * PgBouncer) keeps a transaction on one backend, and the lock is released by
 * COMMIT/ROLLBACK or by the server if the connection dies, so it can neither
 * leak nor be silently shared. Writes made through `client` commit together at
 * the end; callers must stay idempotent if that commit fails after an external
 * side effect (both callers re-discover provider objects by receipt/notes).
 */
export async function withSerialLock<T>(key: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const run = async (client: Queryable) => {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '20s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  };
  if (prefersNeonHttp()) {
    const pool = new NeonPool({ connectionString: connectionString(), max: 1 });
    const client = await pool.connect();
    try {
      await run(client);
      const result = await fn(wrapClient(client, () => client.release()));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead; the server releases the lock */ }
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }

  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    await run(client);
    const result = await fn(wrapClient(client, () => client.release()));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T = QueryRow>(client: Client, sql: string, values: unknown[] = []): Promise<T | undefined> {
  return (await client.query<T>(sql, values)).rows[0];
}

export const pool: PoolLike = {
  query: async (sql, values = []) => ({ rows: await query(sql, values) }),
  connect: async () => {
    if (prefersNeonHttp()) {
      const neonPool = new NeonPool({ connectionString: connectionString(), max: 1 });
      const client = await neonPool.connect();
      return wrapClient(client, () => {
        client.release();
        void neonPool.end();
      });
    }
    const pgPool = await getPgPool();
    const client = await pgPool.connect();
    return wrapClient(client, () => client.release());
  },
  end: async () => {
    if (globalDb.festivalPgPool) {
      await globalDb.festivalPgPool.end();
      globalDb.festivalPgPool = undefined;
    }
  },
};
