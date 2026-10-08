/**
 * Regressions for defects found by the independent re-audit of 51a62c4:
 * N-A serial locks (transaction-scoped, never leaked), N-C post-expiry
 * reconcile timing, N-D refunds that never reached the provider, quantity
 * change on an unpaid hold, CREDENTIAL_KEY mismatch in the staff CLI path.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, expireNow, makeShow, makeUser, pool, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let db: typeof import('../src/lib/db');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let refunds: typeof import('../src/lib/refunds');
let jobs: typeof import('../src/lib/jobs');
let catalogue: typeof import('../src/lib/catalogue');

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  db = await import('../src/lib/db');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  refunds = await import('../src/lib/refunds');
  jobs = await import('../src/lib/jobs');
  catalogue = await import('../src/lib/catalogue');
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

async function buy(user: User, productId: string) {
  const h = (await commerce.reserve(user, { productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  const order = await payments.createPaymentOrder(user, h.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return h.id;
}

test('N-A: serial lock is released when the section throws, and serialises concurrent sections', { skip }, async () => {
  await assert.rejects(() => db.withSerialLock('k-test', async () => { throw new Error('boom'); }), /boom/);
  // If the lock had leaked, this would wait for lock_timeout (20 s) and fail.
  const started = Date.now();
  assert.equal(await db.withSerialLock('k-test', async () => 'ok'), 'ok');
  assert.ok(Date.now() - started < 5000);
  let inside = 0;
  let maxInside = 0;
  await Promise.all(Array.from({ length: 6 }, () => db.withSerialLock('k-serial', async () => {
    inside += 1; maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 30));
    inside -= 1;
  })));
  assert.equal(maxInside, 1, 'never two holders at once');
  // Writes inside the section are rolled back with it.
  await assert.rejects(() => db.withSerialLock('k-tx', async (c) => {
    await c.query("INSERT INTO reconciliation_cases(key,kind,detail) VALUES('lock-rollback','TEST','{}')");
    throw new Error('abort');
  }));
  assert.equal((await db.query("SELECT 1 FROM reconciliation_cases WHERE key='lock-rollback'")).length, 0);
});

test('N-C: a payment captured just after hold expiry is re-checked within minutes, not hours', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const h = (await commerce.reserve(user, { productId: show.productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  const order = await payments.createPaymentOrder(user, h.id);
  // Many live checks while the customer sat in the modal.
  for (let i = 0; i < 8; i += 1) {
    await db.query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE booking_id=$1', [h.id]);
    await payments.reconcileOpenRazorpayPayments();
  }
  await expireNow(h.id);
  await commerce.expireHolds();
  await db.query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE booking_id=$1', [h.id]);
  await payments.reconcileOpenRazorpayPayments();
  const next = (await db.query<{ mins: number }>("SELECT EXTRACT(EPOCH FROM next_reconcile_at - now())/60 AS mins FROM payment_attempts WHERE booking_id=$1", [h.id]))[0];
  assert.ok(Number(next.mins) <= 3, `next check in ${Number(next.mins).toFixed(1)} min`);
  fake.pay(order.orderId);
  await db.query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE booking_id=$1', [h.id]);
  await payments.reconcileOpenRazorpayPayments();
  assert.equal((await db.query('SELECT status FROM bookings WHERE id=$1', [h.id]))[0].status, 'CONFIRMED');
});

test('N-D: refund job exhausted while Razorpay was down is alerted and re-driven exactly once', { skip }, async () => {
  const show = await makeShow();
  const bookingId = await buy(await makeUser(), show.productId);
  await catalogue.updateShow(await makeUser('owner'), show.showId, { status: 'CANCELLED', confirmCancellation: true });
  fake.down = true;
  for (let i = 0; i < 6; i += 1) {
    await db.query("UPDATE jobs SET run_at=now() WHERE kind='REFUND' AND state='PENDING'");
    await jobs.processJobs();
  }
  assert.equal((await db.query("SELECT state FROM jobs WHERE kind='REFUND'"))[0].state, 'FAILED');
  const r = (await db.query<{ id: string; state: string; provider_refund_id: string | null }>('SELECT id, state, provider_refund_id FROM refunds WHERE booking_id=$1', [bookingId]))[0];
  assert.equal(r.provider_refund_id, null);
  await db.query("UPDATE refunds SET created_at=now() - interval '2 hours' WHERE id=$1", [r.id]);
  const { opsStatus } = await import('../src/lib/ops');
  assert.ok((await opsStatus()).critical.some((c) => /not sent to the provider/.test(c)), 'money stall is critical');
  fake.down = false;
  await db.query('UPDATE refunds SET last_checked_at=NULL WHERE id=$1', [r.id]);
  await refunds.pollProcessingRefunds();
  assert.equal((await db.query('SELECT state FROM refunds WHERE id=$1', [r.id]))[0].state, 'SUCCEEDED');
  await db.query('UPDATE refunds SET last_checked_at=NULL WHERE id=$1', [r.id]);
  await refunds.pollProcessingRefunds();
  assert.equal(fake.refunds.size, 1, 're-drive never duplicates the provider refund');
});

test('a resolved failed-refund case clears the critical alert', { skip }, async () => {
  const show = await makeShow();
  const bookingId = await buy(await makeUser(), show.productId);
  await catalogue.updateShow(await makeUser('owner'), show.showId, { status: 'CANCELLED', confirmCancellation: true });
  fake.refundStatus = 'failed';
  await jobs.processJobs();
  const { opsStatus } = await import('../src/lib/ops');
  assert.ok((await opsStatus()).critical.some((c) => /refund/.test(c)));
  const refundId = (await db.query<{ id: string }>('SELECT id FROM refunds WHERE booking_id=$1', [bookingId]))[0].id;
  await db.query("UPDATE reconciliation_cases SET state='RESOLVED' WHERE key=$1", ['refund-failed:' + refundId]);
  assert.equal((await opsStatus()).critical.length, 0);
});

test('changing quantity before paying replaces the unpaid hold; inventory stays exact', { skip }, async () => {
  const show = await makeShow({ allocation: 10 });
  const user = await makeUser();
  const first = (await commerce.reserve(user, { productId: show.productId, quantity: 2, version: 1 }, randomUUID())) as { id: string };
  const second = (await commerce.reserve(user, { productId: show.productId, quantity: 3, version: 1 }, randomUUID())) as { id: string; quantity: number };
  assert.notEqual(second.id, first.id);
  assert.equal(Number(second.quantity), 3);
  // Replaced holds are CANCELLED (superseded), so a late payment on them is refunded.
  assert.equal((await db.query('SELECT status FROM bookings WHERE id=$1', [first.id]))[0].status, 'CANCELLED');
  assert.deepEqual(await pool(show.poolId), { allocation: 10, held: 3, committed: 0 });
  // A payment order no longer protects a hold from a changed cart: it is superseded;
  // a late payment on its order is refunded (covered in integration-cart-retry).
  await payments.createPaymentOrder(user, second.id);
  const third = (await commerce.reserve(user, { productId: show.productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  assert.notEqual(third.id, second.id);
  assert.deepEqual(await pool(show.poolId), { allocation: 10, held: 1, committed: 0 });
});

test('confirmed bookings leave the reconciliation schedule', { skip }, async () => {
  const show = await makeShow();
  const bookingId = await buy(await makeUser(), show.productId);
  assert.equal((await db.query('SELECT next_reconcile_at FROM payment_attempts WHERE booking_id=$1', [bookingId]))[0].next_reconcile_at, null);
});
