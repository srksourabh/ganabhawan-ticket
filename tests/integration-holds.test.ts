/**
 * DB-backed hold idempotency and inventory concurrency (real Postgres, real
 * global advisory lock + row locks + CHECK constraints).
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, booking, checkoutSignature, expireNow, makeShow, makeUser, pool, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
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

type Hold = { id: string; status: string; total: number };
const hold = (user: Awaited<ReturnType<typeof makeUser>>, productId: string, quantity: number, key: string) =>
  commerce.reserve(user, { productId, quantity, version: 1 }, key) as Promise<Hold>;

async function purchase(user: Awaited<ReturnType<typeof makeUser>>, bookingId: string) {
  const order = await payments.createPaymentOrder(user, bookingId);
  const p = fake.pay(order.orderId);
  return payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
}

test('1: the same request repeated returns the same booking', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const key = randomUUID();
  const a = await hold(user, show.productId, 2, key);
  const b = await hold(user, show.productId, 2, key);
  assert.equal(a.id, b.id);
  assert.equal((await pool(show.poolId)).held, 2);
});

test('2/3: double-click and browser retry (10 concurrent, same key) create one hold', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 10 }, () => hold(user, show.productId, 1, key)));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal((await pool(show.poolId)).held, 1);
});

test('two tabs / mobile retry (10 concurrent, different keys) reuse the one live hold', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const results = await Promise.all(Array.from({ length: 10 }, () => hold(user, show.productId, 1, randomUUID())));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal((await pool(show.poolId)).held, 1);
  await assert.rejects(() => hold(user, show.productId, 3, randomUUID()), /checkout in progress/i);
});

test('6: a new checkout after an expired hold gets a new hold (no 48 h lockout)', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const first = await hold(user, show.productId, 2, randomUUID());
  await expireNow(first.id);
  await commerce.expireHolds();
  const second = await hold(user, show.productId, 2, randomUUID());
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'HELD');
  const order = await payments.createPaymentOrder(user, second.id);
  assert.ok(order.orderId);
});

test('retrying an old checkout key reports the current state, never a stale HELD snapshot', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const key = randomUUID();
  const first = await hold(user, show.productId, 1, key);
  await expireNow(first.id);
  await commerce.expireHolds();
  const again = await hold(user, show.productId, 1, key);
  assert.equal(again.id, first.id);
  assert.equal(again.status, 'EXPIRED');
});

test('4/5: the same customer can buy the same product and quantity again after a purchase', { skip }, async () => {
  const show = await makeShow({ allocation: 10 });
  const user = await makeUser();
  const first = await hold(user, show.productId, 2, randomUUID());
  assert.equal((await purchase(user, first.id)).status, 'CONFIRMED');
  const second = await hold(user, show.productId, 2, randomUUID());
  assert.notEqual(second.id, first.id);
  assert.equal((await purchase(user, second.id)).status, 'CONFIRMED');
  assert.deepEqual(await pool(show.poolId), { allocation: 10, held: 0, committed: 4 });
});

test('7: 10 customers race for the final ticket: exactly one wins, inventory never negative', { skip }, async () => {
  const show = await makeShow({ allocation: 1 });
  const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
  const outcomes = await Promise.allSettled(users.map((u) => hold(u, show.productId, 1, randomUUID())));
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  for (const o of outcomes) if (o.status === 'rejected') assert.match(String(o.reason), /Not enough tickets/);
  assert.deepEqual(await pool(show.poolId), { allocation: 1, held: 1, committed: 0 });
});

test('server price is authoritative: a stale client version is refused', { skip }, async () => {
  const show = await makeShow({ price: 50000 });
  const user = await makeUser();
  await query('UPDATE products SET price=1, version=2 WHERE id=$1', [show.productId]);
  await assert.rejects(() => hold(user, show.productId, 1, randomUUID()), /price has changed/i);
  const fresh = (await commerce.reserve(user, { productId: show.productId, quantity: 1, version: 2 }, randomUUID())) as Hold;
  assert.equal(Number(fresh.total), 1, 'the total comes from the server row, not the client');
});

test('quantity and product id are validated', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  await assert.rejects(() => hold(user, show.productId, 0, randomUUID()), /valid ticket quantity/);
  await assert.rejects(() => hold(user, show.productId, 99, randomUUID()), /valid ticket quantity/);
  await assert.rejects(() => hold(user, randomUUID(), 1, randomUUID()), /not available/);
  await assert.rejects(() => hold(user, show.productId, 1, 'short'), /idempotency key/);
});

test('sales close at curtain: a started show cannot be held', { skip }, async () => {
  const show = await makeShow({ startsInMinutes: -5 });
  const user = await makeUser();
  await assert.rejects(() => hold(user, show.productId, 1, randomUUID()), /closed/i);
});

test('a booking is never confirmed twice and inventory is never committed twice', { skip }, async () => {
  const show = await makeShow({ allocation: 3 });
  const user = await makeUser();
  const h = await hold(user, show.productId, 1, randomUUID());
  const order = await payments.createPaymentOrder(user, h.id);
  const p = fake.pay(order.orderId);
  const confirm = () => payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  await Promise.allSettled([confirm(), confirm(), confirm(), payments.syncRazorpayPayment(user, h.id), payments.reconcileOpenRazorpayPayments()]);
  assert.equal((await booking(h.id)).status, 'CONFIRMED');
  assert.equal((await query('SELECT 1 FROM tickets WHERE booking_id=$1', [h.id])).length, 1);
  assert.equal((await query('SELECT 1 FROM payments WHERE booking_id=$1', [h.id])).length, 1);
  assert.deepEqual(await pool(show.poolId), { allocation: 3, held: 0, committed: 1 });
});
