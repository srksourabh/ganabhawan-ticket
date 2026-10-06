/**
 * DB-backed payment lifecycle: real Postgres, real application code, Razorpay
 * HTTP simulated by FakeRazorpay. Covers the late-payment cases A–F,
 * concurrency on order creation and webhooks, and reconciliation fairness.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import {
  DB_AVAILABLE, booking, checkoutSignature, expireNow, makeShow, makeUser, pool, resetDatabase, useLiveStagingEnv, webhook,
} from './helpers/fixtures';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
// Imported lazily so env is set first.
let reserve: typeof import('../src/lib/commerce').reserve;
let expireHolds: typeof import('../src/lib/commerce').expireHolds;
let createPaymentOrder: typeof import('../src/lib/payments').createPaymentOrder;
let verifyRazorpayCallback: typeof import('../src/lib/payments').verifyRazorpayCallback;
let ingestRazorpayWebhook: typeof import('../src/lib/payments').ingestRazorpayWebhook;
let reconcile: typeof import('../src/lib/payments').reconcileOpenRazorpayPayments;
let syncRazorpayPayment: typeof import('../src/lib/payments').syncRazorpayPayment;
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  ({ reserve, expireHolds } = await import('../src/lib/commerce'));
  ({ createPaymentOrder, verifyRazorpayCallback, ingestRazorpayWebhook, reconcileOpenRazorpayPayments: reconcile, syncRazorpayPayment } = await import('../src/lib/payments'));
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

async function holdAndOrder(user: Awaited<ReturnType<typeof makeUser>>, productId: string, quantity = 1) {
  const hold = (await reserve(user, { productId, quantity, version: 1 }, randomUUID())) as { id: string; total: number };
  const order = await createPaymentOrder(user, hold.id);
  return { bookingId: hold.id, orderId: order.orderId, amount: order.amount };
}

async function paymentsFor(bookingId: string) {
  return query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM payments WHERE booking_id=$1', [bookingId]);
}

test('A: payment before expiry is verified and confirmed with tickets and credentials', { skip }, async () => {
  const show = await makeShow({ allocation: 5 });
  const user = await makeUser();
  const { bookingId, orderId, amount } = await holdAndOrder(user, show.productId, 2);
  assert.equal(amount, show.price * 2, 'amount is server-derived from the product price');
  const payment = fake.pay(orderId);
  const result = await verifyRazorpayCallback(
    { razorpay_order_id: orderId, razorpay_payment_id: payment.id, razorpay_signature: checkoutSignature(orderId, payment.id) },
    user,
  );
  assert.equal(result.status, 'CONFIRMED');
  assert.deepEqual(await pool(show.poolId), { allocation: 5, held: 0, committed: 2 });
  const tickets = await query('SELECT t.id FROM tickets t JOIN credentials c ON c.ticket_id=t.id AND c.status=$2 WHERE t.booking_id=$1', [bookingId, 'ACTIVE']);
  assert.equal(tickets.length, 2);
  assert.equal((await query("SELECT 1 FROM jobs WHERE kind='DELIVERY' AND key=$1", ['confirmation:' + bookingId])).length, 1);
});

test('forged checkout signature and amount mismatch are rejected; nothing is confirmed', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const { bookingId, orderId } = await holdAndOrder(user, show.productId);
  const payment = fake.pay(orderId);
  await assert.rejects(() => verifyRazorpayCallback({ razorpay_order_id: orderId, razorpay_payment_id: payment.id, razorpay_signature: 'f'.repeat(64) }, user), /verification failed/i);
  const short = fake.pay(orderId, { amount: 100 });
  await assert.rejects(
    () => verifyRazorpayCallback({ razorpay_order_id: orderId, razorpay_payment_id: short.id, razorpay_signature: checkoutSignature(orderId, short.id) }, user),
    /does not match/i,
  );
  assert.equal((await booking(bookingId)).status, 'PAYMENT_PENDING');
});

test('another customer cannot confirm, sync or order against my booking', { skip }, async () => {
  const show = await makeShow();
  const owner = await makeUser();
  const intruder = await makeUser();
  const { bookingId, orderId } = await holdAndOrder(owner, show.productId);
  const payment = fake.pay(orderId);
  await assert.rejects(() => createPaymentOrder(intruder, bookingId), /not found/i);
  await assert.rejects(() => syncRazorpayPayment(intruder, bookingId), /not found/i);
  await assert.rejects(
    () => verifyRazorpayCallback({ razorpay_order_id: orderId, razorpay_payment_id: payment.id, razorpay_signature: checkoutSignature(orderId, payment.id) }, intruder),
    /not found/i,
  );
});

test('payment declined: no booking confirmed, hold expires and inventory is released', { skip }, async () => {
  const show = await makeShow({ allocation: 3 });
  const user = await makeUser();
  const { bookingId, orderId } = await holdAndOrder(user, show.productId);
  fake.pay(orderId, { status: 'failed' });
  await assert.rejects(() => syncRazorpayPayment(user, bookingId), /not yet captured/i);
  assert.equal((await pool(show.poolId)).held, 1);
  await expireNow(bookingId);
  await expireHolds();
  assert.equal((await booking(bookingId)).status, 'EXPIRED');
  assert.deepEqual(await pool(show.poolId), { allocation: 3, held: 0, committed: 0 });
});

test('10 simultaneous order requests for one booking create exactly one provider order', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const hold = (await reserve(user, { productId: show.productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  fake.latencyMs = 40;
  const results = await Promise.all(Array.from({ length: 10 }, () => createPaymentOrder(user, hold.id)));
  const ids = new Set(results.map((r) => r.orderId));
  assert.equal(ids.size, 1, 'every caller receives the same order');
  assert.equal(fake.orders.size, 1, 'only one order exists at the provider');
  const attempts = await query("SELECT provider_order_id FROM payment_attempts WHERE booking_id=$1 AND state='READY'", [hold.id]);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].provider_order_id, [...ids][0]);
});

test('F: the same webhook delivered 10 times concurrently settles once', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const { bookingId, orderId } = await holdAndOrder(user, show.productId, 2);
  const payment = fake.pay(orderId);
  const { body, signature } = webhook('payment.captured', payment);
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => ingestRazorpayWebhook(body, signature)));
  assert.ok(outcomes.some((o) => o.status === 'fulfilled'));
  assert.equal((await paymentsFor(bookingId)).length, 1);
  assert.equal((await booking(bookingId)).status, 'CONFIRMED');
  assert.equal((await query('SELECT 1 FROM tickets WHERE booking_id=$1', [bookingId])).length, 2);
  assert.equal((await pool(show.poolId)).committed, 2);
  assert.deepEqual(await ingestRazorpayWebhook(body, signature), { duplicate: true });
});

test('webhook with a bad signature is rejected', { skip }, async () => {
  const { body } = webhook('payment.captured', { id: 'pay_x', order_id: 'order_x', amount: 1, currency: 'INR', status: 'captured' });
  await assert.rejects(() => ingestRazorpayWebhook(body, '0'.repeat(64)), /signature/i);
});

test('D/E: browser closed after paying and no webhook: reconciliation confirms', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const { bookingId, orderId } = await holdAndOrder(user, show.productId);
  fake.pay(orderId);
  const summary = await reconcile();
  assert.equal(summary.settled, 1);
  assert.equal((await booking(bookingId)).status, 'CONFIRMED');
});

test('B: payment captured after hold expiry with capacity left: confirmed', { skip }, async () => {
  const show = await makeShow({ allocation: 2 });
  const user = await makeUser();
  const { bookingId, orderId } = await holdAndOrder(user, show.productId);
  await expireNow(bookingId);
  await expireHolds();
  assert.equal((await booking(bookingId)).status, 'EXPIRED');
  fake.pay(orderId);
  await reconcile();
  assert.equal((await booking(bookingId)).status, 'CONFIRMED');
  assert.deepEqual(await pool(show.poolId), { allocation: 2, held: 0, committed: 1 });
});

test('C: payment after expiry with no capacity left: REFUND_REQUIRED, refunded once, then REFUNDED', { skip }, async () => {
  const show = await makeShow({ allocation: 1 });
  const late = await makeUser();
  const winner = await makeUser();
  const first = await holdAndOrder(late, show.productId);
  await expireNow(first.bookingId);
  await expireHolds();
  const second = await holdAndOrder(winner, show.productId);
  const winnerPay = fake.pay(second.orderId);
  await verifyRazorpayCallback({ razorpay_order_id: second.orderId, razorpay_payment_id: winnerPay.id, razorpay_signature: checkoutSignature(second.orderId, winnerPay.id) }, winner);
  const latePay = fake.pay(first.orderId);
  const { body, signature } = webhook('payment.captured', latePay);
  await ingestRazorpayWebhook(body, signature);
  assert.equal((await booking(first.bookingId)).status, 'REFUND_REQUIRED');
  assert.deepEqual(await pool(show.poolId), { allocation: 1, held: 0, committed: 1 }, 'inventory never oversold');
  const { processJobs } = await import('../src/lib/jobs');
  await processJobs();
  assert.equal(fake.refunds.size, 1);
  assert.equal([...fake.refunds.values()][0].amount, show.price);
  assert.equal((await query('SELECT state FROM refunds WHERE booking_id=$1', [first.bookingId]))[0].state, 'SUCCEEDED');
  assert.equal((await booking(first.bookingId)).status, 'REFUNDED');
  await processJobs();
  assert.equal(fake.refunds.size, 1, 'a second tick never refunds again');
});

test('a second payment on an already confirmed order is refunded, not double-booked', { skip }, async () => {
  const show = await makeShow({ allocation: 5 });
  const user = await makeUser();
  const { bookingId, orderId } = await holdAndOrder(user, show.productId);
  const p1 = fake.pay(orderId);
  await verifyRazorpayCallback({ razorpay_order_id: orderId, razorpay_payment_id: p1.id, razorpay_signature: checkoutSignature(orderId, p1.id) }, user);
  const p2 = fake.pay(orderId);
  const { body, signature } = webhook('payment.captured', p2);
  await ingestRazorpayWebhook(body, signature);
  assert.equal((await paymentsFor(bookingId)).length, 2);
  assert.equal((await query('SELECT 1 FROM tickets WHERE booking_id=$1', [bookingId])).length, 1);
  assert.equal((await query('SELECT 1 FROM refunds WHERE booking_id=$1', [bookingId])).length, 1);
  assert.equal((await pool(show.poolId)).committed, 1);
});

test('reconciliation cannot starve: 25 abandoned + 25 live paid orders, batch of 20', { skip }, async () => {
  const show = await makeShow({ allocation: 200 });
  const abandoned: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    const { bookingId } = await holdAndOrder(await makeUser(), show.productId);
    abandoned.push(bookingId);
  }
  // Abandoned checkouts are older and expired, so they sort first.
  await query("UPDATE bookings SET expires_at=now() - interval '1 hour', created_at=now() - interval '2 hours' WHERE id = ANY($1::uuid[])", [abandoned]);
  await query("UPDATE payment_attempts SET created_at=now() - interval '2 hours', next_reconcile_at=now() - interval '1 hour' WHERE booking_id = ANY($1::uuid[])", [abandoned]);
  await expireHolds();
  const live: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    const { bookingId, orderId } = await holdAndOrder(await makeUser(), show.productId);
    fake.pay(orderId); // paid, browser closed, webhook lost
    live.push(bookingId);
  }
  await query("UPDATE payment_attempts SET next_reconcile_at=now() WHERE booking_id = ANY($1::uuid[])", [live]);
  for (let run = 0; run < 3; run += 1) await reconcile(20);
  const confirmed = await query("SELECT count(*)::int n FROM bookings WHERE id = ANY($1::uuid[]) AND status='CONFIRMED'", [live]);
  assert.equal(confirmed[0].n, 25, 'every paid order was reached within 3 batches');
  const backedOff = await query(
    "SELECT count(*)::int n FROM payment_attempts WHERE booking_id = ANY($1::uuid[]) AND next_reconcile_at > now() + interval '1 minute'",
    [abandoned],
  );
  assert.equal(backedOff[0].n, 25, 'abandoned orders were pushed back, not re-polled every tick');
});

test('abandoned orders retire after the retention window; a later webhook still settles', { skip }, async () => {
  const show = await makeShow({ allocation: 3 });
  const user = await makeUser();
  const { bookingId, orderId } = await holdAndOrder(user, show.productId);
  await expireNow(bookingId);
  await expireHolds();
  await query("UPDATE payment_attempts SET created_at=now() - interval '8 days', next_reconcile_at=now() WHERE booking_id=$1", [bookingId]);
  await reconcile();
  assert.equal((await query('SELECT next_reconcile_at FROM payment_attempts WHERE booking_id=$1', [bookingId]))[0].next_reconcile_at, null);
  const payment = fake.pay(orderId);
  const { body, signature } = webhook('payment.captured', payment);
  await ingestRazorpayWebhook(body, signature);
  assert.equal((await booking(bookingId)).status, 'CONFIRMED');
});

test('a capture on an order we never stored opens a reconciliation case (no silent loss)', { skip }, async () => {
  const { body, signature } = webhook('payment.captured', { id: 'pay_orphan', order_id: 'order_unknown', amount: 5000, currency: 'INR', status: 'captured' });
  await ingestRazorpayWebhook(body, signature);
  const cases = await query("SELECT key FROM reconciliation_cases WHERE state='OPEN'");
  assert.ok(cases.some((c) => String(c.key).startsWith('unknown-order:')));
});

test('provider outage during order creation leaves the hold intact and retry succeeds', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const hold = (await reserve(user, { productId: show.productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  fake.down = true;
  await assert.rejects(() => createPaymentOrder(user, hold.id), /unavailable|payment provider/i);
  assert.equal((await pool(show.poolId)).held, 1);
  fake.down = false;
  const order = await createPaymentOrder(user, hold.id);
  assert.ok(order.orderId.startsWith('order_'));
  assert.equal(fake.orders.size, 1);
});

test('orders left by the old development adapter (dev-…) are never sent to Razorpay', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const hold = (await reserve(user, { productId: show.productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  await query("INSERT INTO payment_attempts(booking_id,provider_order_id,state) VALUES($1,$2,'READY')", [hold.id, 'dev-' + hold.id]);
  await expireNow(hold.id);
  await expireHolds();
  const summary = await reconcile();
  assert.equal(summary.checked, 0);
  assert.equal(fake.count('GET /orders/'), 0);
});
