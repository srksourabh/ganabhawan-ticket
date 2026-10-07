import test from 'node:test';
import assert from 'node:assert/strict';

// Neon HTTP path with a fake fetch: no network, no database.
process.env.DATABASE_URL = 'postgresql://u:p@ep-test-pooler.example.neon.tech/db?sslmode=require';
process.env.DB_QUERY_TIMEOUT_MS = '200';
const { query } = await import('../src/lib/db');

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('a stalled Neon HTTP query fails after the timeout and is not sent twice', async () => {
  let calls = 0;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    calls += 1;
    return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
  }) as typeof fetch;
  const started = Date.now();
  await assert.rejects(query('UPDATE jobs SET attempts = attempts + 1'));
  assert.ok(Date.now() - started < 2000, 'bounded by DB_QUERY_TIMEOUT_MS');
  assert.equal(calls, 1, 'a timed-out statement may have run: no retry');
});

test('other fetch errors are retried as before', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(query('SELECT 1'));
  assert.equal(calls, 3);
});
