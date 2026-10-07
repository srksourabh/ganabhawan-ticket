/**
 * Tester report (Oct 2026): add 1 ticket → checkout → Razorpay opened and
 * dismissed → change quantity → checkout again → "You already have a checkout
 * in progress". Dismissing the modal is purely client-side, so the server sees
 * a PAYMENT_PENDING booking with a READY order. These tests pin the required
 * behaviour on the single-booking path (existing bookings / PayBookingButton).
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, pool, resetDatabase, useLiveStagingEnv, webhook } from './helpers/fixtures';
import type { User } from '../src/lib/types';

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

/** Hold + open the Razorpay order (modal shown); the customer then dismisses it. */
async function openAndDismiss(user: User, productId: string, quantity: number) {
  const hold = (await commerce.reserve(user, { productId, quantity, version: 1 }, randomUUID())) as { id: string };
  const order = await payments.createPaymentOrder(user, hold.id);
  return { bookingId: hold.id, orderId: order.orderId, amount: order.amount };
}

for (const [from, to] of [[1, 2], [1, 3], [3, 1], [3, 2], [2, 3]] as const) {
  test(`quantity ${from} → ${to} after a dismissed payment creates the correct new hold (no "checkout in progress")`, { skip }, async () => {
    const show = await makeShow({ allocation: 10, price: 50000 });
    const user = await makeUser();
    const first = await openAndDismiss(user, show.productId, from);
    assert.deepEqual(await pool(show.poolId), { allocation: 10, held: from, committed: 0 });
    const second = await openAndDismiss(user, show.productId, to);
    assert.notEqual(second.bookingId, first.bookingId);
    assert.equal(second.amount, 50000 * to, 'order is for the new quantity');
    assert.deepEqual(await pool(show.poolId), { allocation: 10, held: to, committed: 0 }, 'old hold released: no inventory leak');
    assert.equal((await query('SELECT status FROM bookings WHERE id=$1', [first.bookingId]))[0].status, 'CANCELLED', 'superseded, not left active');
    const p = fake.pay(second.orderId);
    const res = await payments.verifyRazorpayCallback({ razorpay_order_id: second.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(second.orderId, p.id) }, user);
    assert.equal(res.status, 'CONFIRMED');
    assert.equal((await query('SELECT count(*)::int n FROM tickets WHERE booking_id=$1', [second.bookingId]))[0].n, to);
  });
}

test('same quantity retried after a dismissed payment reuses the same hold and order', { skip }, async () => {
  const show = await makeShow({ allocation: 10 });
  const user = await makeUser();
  const a = await openAndDismiss(user, show.productId, 2);
  const b = await openAndDismiss(user, show.productId, 2);
  assert.equal(b.bookingId, a.bookingId);
  assert.equal(b.orderId, a.orderId);
  assert.equal(fake.orders.size, 1);
  assert.equal((await pool(show.poolId)).held, 2);
});

test('the superseded order, if paid late in another tab, is refunded, never confirmed alongside the new one', { skip }, async () => {
  const show = await makeShow({ allocation: 10, price: 25000 });
  const user = await makeUser();
  const old = await openAndDismiss(user, show.productId, 1);
  await openAndDismiss(user, show.productId, 3);
  const late = fake.pay(old.orderId);
  const { body, signature } = webhook('payment.captured', late);
  await payments.ingestRazorpayWebhook(body, signature);
  assert.equal((await query('SELECT status FROM bookings WHERE id=$1', [old.bookingId]))[0].status, 'CANCELLED');
  assert.equal((await query('SELECT count(*)::int n FROM refunds WHERE booking_id=$1', [old.bookingId]))[0].n, 1, 'late money is refunded');
  assert.equal((await query('SELECT count(*)::int n FROM tickets WHERE booking_id=$1', [old.bookingId]))[0].n, 0);
  assert.equal((await pool(show.poolId)).held, 3);
});
