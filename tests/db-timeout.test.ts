import test from 'node:test';
import assert from 'node:assert/strict';

// Neon HTTP path with a fake fetch: no network, no database.
process.env.DATABASE_URL = 'postgresql://u:p@ep-test-pooler.example.neon.tech/db?sslmode=require';
process.env.DB_QUERY_TIMEOUT_MS = '200';
const { query } = await import('../src/lib/db');

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

/**
 * A request that never answers until it is aborted. A real in-flight request
 * holds an open socket; this holds a referenced timer instead, because
 * AbortSignal.timeout's own timer is unref'd and would otherwise let Node exit
 * with the promise still pending. The timer is cleared as soon as it aborts.
 */
function stalledFetch(onCall: () => void): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => {
    onCall();
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error('query sent without an abort signal'));
      const keepAlive = setTimeout(() => reject(new Error('abort signal never fired')), 5000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
  }) as typeof fetch;
}

test('a stalled Neon HTTP query fails after the timeout and is not sent twice', { timeout: 10_000 }, async () => {
  let calls = 0;
  globalThis.fetch = stalledFetch(() => { calls += 1; });
  const started = Date.now();
  await assert.rejects(query('UPDATE jobs SET attempts = attempts + 1'), (error: Error) => {
    const cause = (error as { sourceError?: Error }).sourceError ?? error;
    assert.equal(cause.name, 'TimeoutError');
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 2000, `bounded by DB_QUERY_TIMEOUT_MS (took ${elapsed} ms)`);
  assert.equal(calls, 1, 'a timed-out statement may have run: no retry');
});

test('other fetch errors are retried as before (3 attempts)', { timeout: 10_000 }, async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(query('SELECT 1'), /fetch failed/);
  assert.equal(calls, 3);
});
