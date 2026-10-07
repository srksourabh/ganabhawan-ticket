/**
 * A worker tick inside a Cloudflare Worker may make at most 50 subrequests on
 * the Free plan. On staging, one tick with a reconciliation backlog made ~56
 * (20 Razorpay order lookups + their DB writes) and died before it claimed the
 * pending confirmation email. These tests count what a tick would cost on
 * Workers, where every Neon HTTP query, every transaction socket and every
 * provider call is one subrequest, and drive the scheduled (cron) path through
 * the real /api/cron/worker route.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
/** Free-plan limit is 50; keep headroom for Neon retries on transient errors. */
const BUDGET = 45;
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let commerce: typeof import('../src/lib/commerce');
let catalogue: typeof import('../src/lib/catalogue');
let jobs: typeof import('../src/lib/jobs');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  for (const name of ['WORKER_JOB_BATCH', 'WORKER_RECONCILE_BATCH', 'WORKER_REFUND_BATCH']) delete process.env[name];
  fake.install();
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  commerce = await import('../src/lib/commerce');
  catalogue = await import('../src/lib/catalogue');
  jobs = await import('../src/lib/jobs');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  fake.reset();
  await resetDatabase();
});

/** Subrequests the wrapped work would make on Workers (Neon HTTP queries + transaction sockets + provider calls). */
async function countSubrequests<T>(work: () => Promise<T>) {
  const proto = pg.Pool.prototype as unknown as { query: (...a: unknown[]) => unknown; connect: (...a: unknown[]) => unknown };
  const { query: realQuery, connect: realConnect } = proto;
  let httpQueries = 0;
  let sockets = 0;
  let insideQuery = false;
  proto.query = function (this: unknown, ...args: unknown[]) {
    httpQueries += 1;
    insideQuery = true; // pg-pool's query() calls connect() synchronously: not a separate socket
    try { return realQuery.apply(this, args); } finally { insideQuery = false; }
  };
  proto.connect = function (this: unknown, ...args: unknown[]) {
    if (!insideQuery) sockets += 1;
    return realConnect.apply(this, args);
  };
  const providerBefore = fake.calls.length;
  try {
    const result = await work();
    return { result, total: httpQueries + sockets + (fake.calls.length - providerBefore) };
  } finally {
    proto.query = realQuery;
    proto.connect = realConnect;
  }
}

async function paidButUnsettledCheckout(user: User) {
  // One live checkout per customer: a second checkout by the same customer supersedes the first.
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const co = await checkout.createCheckout(user, [
    { productId: a.productId, quantity: 1, version: 1 },
    { productId: b.productId, quantity: 1, version: 1 },
  ], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  fake.pay(order.orderId); // captured at Razorpay; the browser never came back
  return co.id;
}

async function paidBooking(user: User, productId: string) {
  const h = (await commerce.reserve(user, { productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  const order = await payments.createPaymentOrder(user, h.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
}

test('every Worker tick stays within the subrequest budget, and a mixed backlog still drains completely', { skip }, async () => {
  // Backlog: 8 captured cart payments only reconciliation can find, abandoned unpaid orders,
  // confirmation emails, and refunds + notices from a cancelled show (refunds stay PROCESSING → polled).
  const missed: { user: User; id: string }[] = [];
  for (let i = 0; i < 8; i += 1) {
    const user = await makeUser();
    missed.push({ user, id: await paidButUnsettledCheckout(user) });
  }
  for (let i = 0; i < 6; i += 1) {
    const s = await makeShow();
    const abandoner = await makeUser();
    const co = await checkout.createCheckout(abandoner, [{ productId: s.productId, quantity: 1, version: 1 }], randomUUID());
    await checkout.createCheckoutPaymentOrder(abandoner, co.id);
  }
  const cancelled = await makeShow({ startsInMinutes: 60 });
  for (let i = 0; i < 4; i += 1) await paidBooking(await makeUser(), cancelled.productId);
  await catalogue.updateShow(await makeUser('owner'), cancelled.showId, { status: 'CANCELLED', confirmCancellation: true });
  fake.refundStatus = 'pending';
  await query("UPDATE payment_attempts SET next_reconcile_at = now() - interval '1 minute' WHERE state='READY'");

  const limits = jobs.workerTickLimits();
  let max = 0;
  for (let tick = 0; tick < 30; tick += 1) {
    await query("UPDATE refunds SET last_checked_at = now() - interval '1 hour'"); // refunds due for polling every tick
    await query("UPDATE jobs SET run_at = now() WHERE state='PENDING'");
    const { result, total } = await countSubrequests(() => jobs.processJobs(limits));
    max = Math.max(max, total);
    assert.ok(total <= BUDGET, `tick ${tick} made ${total} subrequests (budget ${BUDGET}): ${JSON.stringify(result)}`);
    assert.deepEqual(result.errors, []);
    const left = (await query<{ n: number }>("SELECT count(*)::int n FROM jobs WHERE state IN ('PENDING','RUNNING')"))[0].n;
    if (left === 0 && result.reconcile.settled === 0 && tick > 3) break;
  }
  for (const { user, id } of missed) {
    assert.equal((await checkout.checkoutReceipt(user.id, id)).status, 'CONFIRMED', 'reconciliation confirmed every missed payment');
  }
  assert.deepEqual(await query("SELECT state, count(*)::int n FROM jobs GROUP BY state"), [{ state: 'DONE', n: (await query<{ n: number }>('SELECT count(*)::int n FROM jobs'))[0].n }]);
  assert.equal(fake.emails.filter((e) => /GC-/.test(e.subject + e.text)).length >= missed.length, true, 'one confirmation per missed checkout');
  console.log(`[budget] worst tick: ${max} subrequests (limit 50, budget ${BUDGET}), limits ${JSON.stringify(limits)}`);
});

test('the scheduled (cron) tick runs the real /api/cron/worker route with the secret; failures are surfaced', { skip }, async () => {
  const { runScheduledTick } = await import('../worker/scheduled');
  const { POST } = await import('../app/api/cron/worker/route');
  const env = { CRON_SECRET: process.env.CRON_SECRET, APP_URL: process.env.APP_URL };
  const user = await makeUser();
  const id = await paidButUnsettledCheckout(user);
  await query("UPDATE payment_attempts SET next_reconcile_at = now() - interval '1 minute'");

  const seen: Request[] = [];
  await runScheduledTick(async (request) => { seen.push(request); return POST(request); }, env);
  assert.equal(new URL(seen[0].url).pathname, '/api/cron/worker');
  assert.equal((await checkout.checkoutReceipt(user.id, id)).status, 'CONFIRMED', 'the cron tick reconciled the captured payment');

  await assert.rejects(runScheduledTick(POST, { ...env, CRON_SECRET: 'wrong-secret-value' }), /HTTP 401/);
  await assert.rejects(runScheduledTick(POST, { APP_URL: env.APP_URL }), /CRON_SECRET and APP_URL/);
  await assert.rejects(runScheduledTick(async () => new Response('{}', { status: 500 }), env), /HTTP 500/);
});
