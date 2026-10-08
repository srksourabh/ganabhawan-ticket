import test from 'node:test';
import assert from 'node:assert/strict';

// /api/health on the Neon HTTP path with a fake fetch: no network, no database.
process.env.DATABASE_URL = 'postgresql://u:p@ep-test-pooler.example.neon.tech/db?sslmode=require';
const { GET } = await import('../app/api/health/route');

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

/** A Neon HTTP response (array mode, text-encoded values, typed by OID). */
const neonRow = (name: string, oid: number, value: string) =>
  new Response(JSON.stringify({ command: 'SELECT', rowCount: 1, rowAsArray: true, fields: [{ name, dataTypeID: oid }], rows: [[value]] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

test('health: reachable DB with the schema reports db:true and schema:true; only read-only statements are sent', { timeout: 10_000 }, async () => {
  const sent: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    sent.push(query);
    return query.includes('to_regclass') ? neonRow('ok', 16, 't') : neonRow('?column?', 23, '1');
  }) as typeof fetch;
  const body = await (await GET()).json();
  assert.equal(body.db, true);
  assert.equal(body.schema, true);
  assert.ok(sent.every((q) => /^\s*SELECT\b/i.test(q)), 'health never writes');
});

test('health: a stalled DB answers 503 db:false within the 5 s bound instead of hanging', { timeout: 15_000 }, async () => {
  const timers: NodeJS.Timeout[] = [];
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    // Holds the event loop like an open socket would, until the request is aborted.
    const keepAlive = setTimeout(() => reject(new Error('never aborted')), 30_000);
    timers.push(keepAlive);
    init?.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal!.reason); }, { once: true });
  })) as typeof fetch;
  const started = Date.now();
  const res = await GET();
  const elapsed = Date.now() - started;
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.db, false);
  assert.equal(body.ok, false);
  assert.ok(elapsed >= 4500 && elapsed < 7000, `bounded at ~5 s (took ${elapsed} ms)`);
  // The query itself keeps running until DB_QUERY_TIMEOUT_MS aborts it; do not leave it pending.
  for (const t of timers) clearTimeout(t);
});
