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

/** A mixed backlog drained tick by tick: every tick within the budget, everything completes once. */
async function drainMixedBacklog(label: string) {
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
    assert.ok(total <= BUDGET, `tick ${tick}${label} made ${total} subrequests (budget ${BUDGET}): ${JSON.stringify(result)}`);
    assert.ok(result.processed + result.failed <= limits.jobs && result.reconcile.checked <= limits.reconcile, `tick ${tick}${label} claimed more than its limits: ${JSON.stringify(result)}`);
    assert.deepEqual(result.errors, []);
    const left = (await query<{ n: number }>("SELECT count(*)::int n FROM jobs WHERE state IN ('PENDING','RUNNING')"))[0].n;
    if (left === 0 && result.reconcile.settled === 0 && tick > 3) break;
  }
  for (const { user, id } of missed) {
    assert.equal((await checkout.checkoutReceipt(user.id, id)).status, 'CONFIRMED', 'reconciliation confirmed every missed payment');
  }
  assert.deepEqual(await query("SELECT state, count(*)::int n FROM jobs GROUP BY state"), [{ state: 'DONE', n: (await query<{ n: number }>('SELECT count(*)::int n FROM jobs'))[0].n }]);
  assert.equal(fake.emails.filter((e) => /GC-/.test(e.subject + e.text)).length >= missed.length, true, 'one confirmation per missed checkout');
  console.log(`[budget] worst tick${label}: ${max} subrequests (limit 50, budget ${BUDGET}), limits ${JSON.stringify(limits)}`);
}

/**
 * Stale planner statistics: the tables look analyzed while empty (0 rows over their pages), as
 * autoanalyze leaves them when it runs while a table holds no live rows (e.g. between tests that
 * reset the database, or on a young production database) and rows arrive before the next analyze.
 * With them, a claim written as `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` was planned
 * as a nested loop that rescanned the subquery per row and claimed EVERY due row (CI: 13 jobs for
 * LIMIT 2, 85 subrequests in one tick). Set directly (the test database user is its superuser)
 * because the moment autoanalyze runs cannot be controlled.
 */
async function statisticsOfEmptyTables() {
  await query(`UPDATE pg_class SET reltuples = 0, relpages = 1
    WHERE oid IN ('jobs'::regclass, 'payment_attempts'::regclass, 'refunds'::regclass, 'payments'::regclass, 'bookings'::regclass)`);
}

test('every Worker tick stays within the subrequest budget, and a mixed backlog still drains completely', { skip }, async () => {
  await drainMixedBacklog('');
});

test('the same backlog with statistics of empty tables: no claim exceeds its limit, every tick within budget, all work still done once', { skip }, async () => {
  await statisticsOfEmptyTables();
  await drainMixedBacklog(' (empty-table statistics)');
});

test('job claim: LIMIT holds with empty-table statistics; the rest waits for later ticks and every job runs exactly once', { skip }, async () => {
  await statisticsOfEmptyTables();
  await query(`INSERT INTO jobs(kind,key,payload,state,run_at) SELECT 'EXPIRE','claim-'||g,'{}','PENDING',now()-interval '1 minute' FROM generate_series(1,13) g`);
  const limits = { jobs: 2, reconcile: 3, refunds: 2 };
  const first = await jobs.processJobs(limits);
  assert.equal(first.processed, 2, 'one tick claims at most its limit');
  assert.equal(Number((await query<{ n: number }>("SELECT count(*)::int n FROM jobs WHERE state='PENDING'"))[0].n), 11, 'the rest stays eligible');
  for (let tick = 0; tick < 10; tick += 1) assert.ok((await jobs.processJobs(limits)).processed <= 2);
  assert.deepEqual(await query("SELECT state, attempts, count(*)::int n FROM jobs GROUP BY 1,2"), [{ state: 'DONE', attempts: 1, n: 13 }], 'all 13 done, each claimed once');
});

test('reconciliation and refund claims: LIMIT holds with empty-table statistics, and every refund is still polled once per round', { skip }, async () => {
  await statisticsOfEmptyTables();
  for (let i = 0; i < 6; i += 1) await paidButUnsettledCheckout(await makeUser());
  await query("UPDATE payment_attempts SET next_reconcile_at = now() - interval '1 minute'");
  const reconciled = await payments.reconcileOpenRazorpayPayments(2);
  assert.equal(reconciled.checked, 2, 'reconciliation claims at most its limit');
  assert.equal(Number((await query<{ n: number }>("SELECT count(*)::int n FROM payment_attempts WHERE next_reconcile_at <= now()"))[0].n), 4, 'the other orders stay due');

  const cancelled = await makeShow({ startsInMinutes: 60 });
  for (let i = 0; i < 5; i += 1) await paidBooking(await makeUser(), cancelled.productId);
  fake.refundStatus = 'pending';
  await catalogue.updateShow(await makeUser('owner'), cancelled.showId, { status: 'CANCELLED', confirmCancellation: true });
  // Run every refund and notice job (each refund reaches Razorpay, which reports it pending).
  for (let i = 0; i < 20 && Number((await query<{ n: number }>("SELECT count(*)::int n FROM jobs WHERE state='PENDING'"))[0].n) > 0; i += 1) {
    await query("UPDATE jobs SET run_at = now() WHERE state='PENDING'");
    await jobs.processJobs({ jobs: 5, reconcile: 0, refunds: 0 });
  }
  await statisticsOfEmptyTables();
  const processing = Number((await query<{ n: number }>("SELECT count(*)::int n FROM refunds WHERE state='PROCESSING' AND provider_refund_id IS NOT NULL"))[0].n);
  assert.equal(processing, 5, 'five refunds at the provider, pending');
  const { pollProcessingRefunds } = await import('../src/lib/refunds');
  const polled: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    await query("UPDATE refunds SET last_checked_at = NULL WHERE state='PROCESSING'");
    const before = fake.count('GET /refunds/');
    await pollProcessingRefunds(2);
    polled.push(fake.count('GET /refunds/') - before);
  }
  assert.deepEqual(polled, [2, 2, 2], 'each poll claims at most its limit');
  assert.equal(Number((await query<{ n: number }>("SELECT count(*)::int n FROM refunds WHERE state='SUCCEEDED'"))[0].n), 0, 'nothing marked refunded without the provider');
});

test('worst mix in ONE tick (3 settling reconciliations, 2 stalled + 2 pending refunds, cart confirmations due): within budget, one job slot given up, the rest done later exactly once', { skip }, async () => {
  // Refunds: 2 stalled (never reached the provider) + 2 pending at the provider.
  const cancelled = await makeShow({ startsInMinutes: 60 });
  for (let i = 0; i < 4; i += 1) await paidBooking(await makeUser(), cancelled.productId);
  fake.refundStatus = 'pending';
  await catalogue.updateShow(await makeUser('owner'), cancelled.showId, { status: 'CANCELLED', confirmCancellation: true });
  for (let i = 0; i < 20 && Number((await query<{ n: number }>("SELECT count(*)::int n FROM jobs WHERE state='PENDING'"))[0].n) > 0; i += 1) {
    await query("UPDATE jobs SET run_at = now() WHERE state='PENDING'");
    await jobs.processJobs({ jobs: 5, reconcile: 0, refunds: 0 });
  }
  const refundIds = (await query<{ id: string }>("SELECT id FROM refunds WHERE state='PROCESSING' ORDER BY id")).map((r) => r.id);
  assert.equal(refundIds.length, 4);
  await query("UPDATE refunds SET state='REQUESTED', provider_refund_id=NULL, created_at=now()-interval '2 hours' WHERE id = ANY($1::uuid[])", [refundIds.slice(0, 2)]);
  await query('UPDATE refunds SET last_checked_at = NULL');
  // Two paid cart checkouts whose confirmation (the costliest job) is due, and three the browser never confirmed.
  const buyers: User[] = [];
  for (let i = 0; i < 2; i += 1) {
    const user = await makeUser();
    buyers.push(user);
    const show = await makeShow();
    const co = await checkout.createCheckout(user, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
    const order = await checkout.createCheckoutPaymentOrder(user, co.id);
    const p = fake.pay(order.orderId);
    await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  }
  const missed: { user: User; id: string }[] = [];
  for (let i = 0; i < 3; i += 1) { const user = await makeUser(); missed.push({ user, id: await paidButUnsettledCheckout(user) }); }
  await query("UPDATE payment_attempts SET next_reconcile_at = now() - interval '1 minute' WHERE state='READY'");
  await query("UPDATE jobs SET run_at = now() WHERE state='PENDING'");
  await statisticsOfEmptyTables();

  const limits = jobs.workerTickLimits();
  const { result, total } = await countSubrequests(() => jobs.processJobs(limits));
  console.log(`[budget] worst single tick: ${total} subrequests ${JSON.stringify(result)}`);
  assert.ok(total <= BUDGET, `worst tick made ${total} subrequests (budget ${BUDGET}): ${JSON.stringify(result)}`);
  assert.equal(result.reconcile.settled, 3);
  assert.equal(result.processed, limits.jobs - 1, 'one job slot given up after upkeep');

  for (let tick = 0; tick < 20; tick += 1) {
    await query("UPDATE jobs SET run_at = now() WHERE state='PENDING'");
    await query("UPDATE refunds SET last_checked_at = now() - interval '1 hour'");
    const next = await countSubrequests(() => jobs.processJobs(limits));
    assert.ok(next.total <= BUDGET, `tick ${tick} made ${next.total} subrequests`);
    if (Number((await query<{ n: number }>("SELECT count(*)::int n FROM jobs WHERE state IN ('PENDING','RUNNING')"))[0].n) === 0) break;
  }
  assert.deepEqual(await query("SELECT state, count(*)::int n FROM jobs GROUP BY state"), [{ state: 'DONE', n: (await query<{ n: number }>('SELECT count(*)::int n FROM jobs'))[0].n }], 'every deferred job ran');
  for (const { user, id } of missed) assert.equal((await checkout.checkoutReceipt(user.id, id)).status, 'CONFIRMED');
  for (const user of [...buyers, ...missed.map((m) => m.user)]) {
    assert.equal(fake.emails.filter((e) => e.to === user.contact && /GC-/.test(e.subject + e.text)).length, 1, 'exactly one confirmation per paid checkout');
  }
  assert.deepEqual(await query("SELECT key FROM notification_deliveries GROUP BY key HAVING count(*) > 1"), [], 'no delivery recorded twice');
  assert.equal(Number((await query<{ n: number }>("SELECT count(*)::int n FROM refunds WHERE provider_refund_id IS NOT NULL"))[0].n), 4, 'the stalled refunds reached the provider');
  assert.equal(fake.refunds.size, 4, 'no refund created twice at the provider');
});

test('a tick while Razorpay refuses every call (each refusal is also recorded for Ops) stays within the budget', { skip }, async () => {
  for (let i = 0; i < 8; i += 1) await paidButUnsettledCheckout(await makeUser());
  const cancelled = await makeShow({ startsInMinutes: 60 });
  for (let i = 0; i < 4; i += 1) await paidBooking(await makeUser(), cancelled.productId);
  await catalogue.updateShow(await makeUser('owner'), cancelled.showId, { status: 'CANCELLED', confirmCancellation: true });
  fake.down = true;
  // Refund jobs, stalled refunds re-driven, reconciliations: every provider call fails.
  await query("UPDATE refunds SET created_at = now() - interval '2 hours', last_checked_at = NULL");
  const limits = jobs.workerTickLimits();
  let max = 0;
  for (let tick = 0; tick < 5; tick += 1) {
    await query("UPDATE payment_attempts SET next_reconcile_at = now() - interval '1 minute' WHERE state='READY'");
    await query("UPDATE refunds SET last_checked_at = now() - interval '1 hour'");
    await query("UPDATE jobs SET run_at = now() WHERE state='PENDING'");
    const { total } = await countSubrequests(() => jobs.processJobs(limits));
    max = Math.max(max, total);
    assert.ok(total <= BUDGET, `tick ${tick} made ${total} subrequests while Razorpay was down (budget ${BUDGET})`);
  }
  assert.ok(Number((await query<{ n: number }>("SELECT count(*)::int n FROM audit_events WHERE action='payment.provider.error'"))[0].n) > 0, 'refusals recorded');
  fake.down = false;
  console.log(`[budget] worst tick with Razorpay down: ${max} subrequests (limit 50, budget ${BUDGET})`);
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
