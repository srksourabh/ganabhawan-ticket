/**
 * ONE cart checkout = ONE Razorpay payment (Oct 2026). Real Postgres, real
 * application code; Razorpay/Resend HTTP simulated by FakeRazorpay.
 * Letters in test names map to the requirement list (A–Q).
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, pool, resetDatabase, useLiveStagingEnv, webhook } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let jobs: typeof import('../src/lib/jobs');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  checkout = await import('../src/lib/checkout');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
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

type Line = { productId: string; quantity: number; version?: number };
const lines = (ls: Line[]) => ls.map((l) => ({ productId: l.productId, quantity: l.quantity, version: l.version ?? 1 }));
const start = (user: User, ls: Line[], key = randomUUID()) => checkout.createCheckout(user, lines(ls), key);
async function startAndOrder(user: User, ls: Line[]) {
  const co = await start(user, ls);
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  return { co, order };
}
async function payCallback(user: User, orderId: string, amount?: number) {
  const p = fake.pay(orderId, amount ? { amount } : {});
  return payments.verifyRazorpayCallback({ razorpay_order_id: orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(orderId, p.id) }, user);
}
const bookingsOf = (checkoutId: string) =>
  query<{ id: string; status: string; quantity: number; total: number }>('SELECT id, status, quantity, total FROM bookings WHERE checkout_id=$1 ORDER BY total DESC', [checkoutId]);
const ticketCount = async (checkoutId: string) =>
  (await query<{ n: number }>('SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1', [checkoutId]))[0].n;

test('A: single item → one checkout, one ₹500 order, confirmed with tickets', { skip }, async () => {
  const show = await makeShow({ price: 50000 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: show.productId, quantity: 1 }]);
  assert.equal(co.total, 50000);
  assert.equal(order.amount, 50000);
  const res = await payCallback(user, order.orderId);
  assert.equal(res.status, 'CONFIRMED');
  assert.equal(await ticketCount(co.id), 1);
  assert.equal((await query("SELECT count(*)::int n FROM payments WHERE checkout_id=$1", [co.id]))[0].n, 1);
});

test('B/M: ₹500 + ₹250 → ONE Razorpay order of ₹750, one payment, BOTH lines confirmed', { skip }, async () => {
  const a = await makeShow({ price: 50000, allocation: 5 });
  const b = await makeShow({ price: 25000, allocation: 5 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  assert.equal(order.amount, 75000);
  assert.equal(fake.orders.size, 1, 'exactly one provider order');
  assert.equal([...fake.orders.values()][0].amount, 75000);
  const res = await payCallback(user, order.orderId);
  assert.equal(res.status, 'CONFIRMED');
  assert.deepEqual((await bookingsOf(co.id)).map((x) => x.status), ['CONFIRMED', 'CONFIRMED']);
  assert.equal(await ticketCount(co.id), 2);
  assert.equal((await query('SELECT count(*)::int n FROM payments'))[0].n, 1, 'one payment record for the cart');
  assert.equal((await pool(a.poolId)).committed, 1);
  assert.equal((await pool(b.poolId)).committed, 1);
});

test('C: consolidated receipt lists every line (show, date, qty, unit, line total) and the total; one email', { skip }, async () => {
  const a = await makeShow({ price: 50000, title: 'Macbeth Two' });
  const b = await makeShow({ price: 25000, title: 'Another Programme' });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 2 }, { productId: b.productId, quantity: 1 }]);
  assert.equal(order.amount, 125000);
  await payCallback(user, order.orderId);
  const r = await checkout.checkoutReceipt(user.id, co.id);
  assert.equal(r.total, 125000);
  assert.equal(r.status, 'CONFIRMED');
  assert.ok(r.payment?.reference.startsWith('pay_'));
  const byShow = (title: string) => r.lines.find((l) => l.performances.some((p) => p.title === title))!;
  assert.deepEqual([byShow('Macbeth Two').quantity, byShow('Macbeth Two').unitPrice, byShow('Macbeth Two').lineTotal], [2, 50000, 100000]);
  assert.deepEqual([byShow('Another Programme').quantity, byShow('Another Programme').unitPrice, byShow('Another Programme').lineTotal], [1, 25000, 25000]);
  assert.equal(r.lines.reduce((s, l) => s + l.lineTotal, 0), r.total);
  await jobs.processJobs();
  const mails = fake.emails.filter((m) => m.to === user.contact);
  assert.equal(mails.length, 1, 'one consolidated confirmation, not one per line');
  for (const needle of ['Macbeth Two', 'Another Programme', '2 × ₹500', '1 × ₹250', '₹1,250', `/receipts/${co.id}`]) {
    assert.ok(mails[0].text.includes(needle), `email contains ${needle}`);
  }
  const stranger = await makeUser();
  await assert.rejects(() => checkout.checkoutReceipt(stranger.id, co.id), /not found/i, 'receipt is owner-only');
});

test('D: Razorpay dismissed → nothing confirmed; retry with the same cart reuses the checkout and order; then pays', { skip }, async () => {
  const s = await makeShow({ price: 50000, allocation: 5 });
  const user = await makeUser();
  const first = await startAndOrder(user, [{ productId: s.productId, quantity: 2 }]);
  // modal dismissed: nothing reaches the server
  assert.deepEqual((await bookingsOf(first.co.id)).map((x) => x.status), ['PAYMENT_PENDING']);
  assert.equal(await ticketCount(first.co.id), 0);
  const retry = await startAndOrder(user, [{ productId: s.productId, quantity: 2 }]);
  assert.equal(retry.co.id, first.co.id);
  assert.equal(retry.order.orderId, first.order.orderId);
  assert.equal(fake.orders.size, 1);
  assert.equal((await pool(s.poolId)).held, 2, 'no extra hold');
  assert.equal((await payCallback(user, retry.order.orderId)).status, 'CONFIRMED');
});

test('E: payment failure → no confirmation, cart retry works', { skip }, async () => {
  const s = await makeShow({ price: 25000 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: s.productId, quantity: 1 }]);
  fake.pay(order.orderId, { status: 'failed' });
  await assert.rejects(() => payments.syncRazorpayPayment(user, co.id), /not yet captured/i);
  assert.equal(await ticketCount(co.id), 0);
  const retry = await startAndOrder(user, [{ productId: s.productId, quantity: 1 }]);
  assert.equal(retry.co.id, co.id);
  assert.equal((await payCallback(user, retry.order.orderId)).status, 'CONFIRMED');
});

for (const [from, to] of [[1, 3], [3, 1], [1, 2], [3, 2], [2, 3]] as const) {
  test(`F/G: quantity ${from} → ${to} after a dismissed payment → new checkout for ${to}, old released, no leak`, { skip }, async () => {
    const s = await makeShow({ price: 50000, allocation: 10 });
    const user = await makeUser();
    const old = await startAndOrder(user, [{ productId: s.productId, quantity: from }]);
    const next = await startAndOrder(user, [{ productId: s.productId, quantity: to }]);
    assert.notEqual(next.co.id, old.co.id);
    assert.equal(next.order.amount, 50000 * to);
    assert.deepEqual(await pool(s.poolId), { allocation: 10, held: to, committed: 0 });
    assert.deepEqual((await bookingsOf(old.co.id)).map((x) => x.status), ['CANCELLED']);
    assert.equal((await payCallback(user, next.order.orderId)).status, 'CONFIRMED');
    assert.equal(await ticketCount(next.co.id), to);
  });
}

test('adding a line to the cart replaces the open checkout (one order for the new total)', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const user = await makeUser();
  const one = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }]);
  const both = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  assert.notEqual(both.co.id, one.co.id);
  assert.equal(both.order.amount, 75000);
  assert.equal((await pool(a.poolId)).held, 1);
  assert.equal((await pool(b.poolId)).held, 1);
});

test('H: expired hold → old order refused with a clear message; a new checkout creates a valid hold', { skip }, async () => {
  const s = await makeShow({ price: 25000, allocation: 2 });
  const user = await makeUser();
  const { co } = await startAndOrder(user, [{ productId: s.productId, quantity: 2 }]);
  await query("UPDATE bookings SET expires_at=now() - interval '1 second' WHERE checkout_id=$1", [co.id]);
  await commerce.expireHolds();
  assert.equal((await pool(s.poolId)).held, 0, 'expired hold released');
  await assert.rejects(() => checkout.createCheckoutPaymentOrder(user, co.id), /expired/i);
  const fresh = await startAndOrder(user, [{ productId: s.productId, quantity: 2 }]);
  assert.notEqual(fresh.co.id, co.id);
  assert.equal((await pool(s.poolId)).held, 2);
  assert.equal((await payCallback(user, fresh.order.orderId)).status, 'CONFIRMED');
});

test('I: partial availability → the whole checkout fails, nothing is held, nothing is created', { skip }, async () => {
  const a = await makeShow({ price: 50000, allocation: 5, title: 'Available Play' });
  const b = await makeShow({ price: 25000, allocation: 1, title: 'Sold Out Play' });
  const user = await makeUser();
  await assert.rejects(
    () => start(user, [{ productId: a.productId, quantity: 2 }, { productId: b.productId, quantity: 2 }]),
    /Premier daily: Not enough tickets remain/,
  );
  assert.equal((await pool(a.poolId)).held, 0, 'line A was NOT left held');
  assert.equal((await pool(b.poolId)).held, 0);
  assert.equal((await query('SELECT count(*)::int n FROM bookings'))[0].n, 0);
  assert.equal((await query('SELECT count(*)::int n FROM checkouts'))[0].n, 0);
});

test('J/L: double-click and network retry → one checkout, one Razorpay order', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const user = await makeUser();
  const key = randomUUID();
  const cart = [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }];
  const cos = await Promise.all(Array.from({ length: 10 }, () => start(user, cart, key)));
  assert.equal(new Set(cos.map((c) => c.id)).size, 1);
  fake.latencyMs = 40;
  const orders = await Promise.all(Array.from({ length: 10 }, () => checkout.createCheckoutPaymentOrder(user, cos[0].id)));
  assert.equal(new Set(orders.map((o) => o.orderId)).size, 1, 'all callers converge on one order');
  assert.equal(fake.orders.size, 1, 'one provider order');
  assert.equal((await pool(a.poolId)).held, 1);
  const again = await start(user, cart, key);
  assert.equal(again.id, cos[0].id, 'replayed request returns the same checkout');
});

test('K: two tabs (different keys, same cart, concurrently) → one checkout, one provider order', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const user = await makeUser();
  const cart = [{ productId: a.productId, quantity: 2 }];
  const [t1, t2] = await Promise.all([start(user, cart), start(user, cart)]);
  assert.equal(t1.id, t2.id);
  fake.latencyMs = 30;
  const [o1, o2] = await Promise.all([checkout.createCheckoutPaymentOrder(user, t1.id), checkout.createCheckoutPaymentOrder(user, t2.id)]);
  assert.equal(o1.orderId, o2.orderId);
  assert.equal(fake.orders.size, 1);
  assert.equal((await pool(a.poolId)).held, 2);
});

test('payment verification: underpayment, overpayment, forged signature and another user are all rejected', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const user = await makeUser();
  const intruder = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  await assert.rejects(() => payCallback(user, order.orderId, 50000), /does not match/);
  await assert.rejects(() => payCallback(user, order.orderId, 80000), /does not match/);
  const p = fake.pay(order.orderId);
  await assert.rejects(() => payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: 'f'.repeat(64) }, user), /verification failed/i);
  await assert.rejects(() => payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, intruder), /not found/i);
  await assert.rejects(() => checkout.createCheckoutPaymentOrder(intruder, co.id), /not found/i);
  await assert.rejects(() => payments.syncRazorpayPayment(intruder, co.id), /not found/i);
  assert.equal(await ticketCount(co.id), 0, 'nothing confirmed');
});

test('a tampered checkout total is refused before any order is created (server total == order amount)', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const user = await makeUser();
  const co = await start(user, [{ productId: a.productId, quantity: 1 }]);
  await query('UPDATE checkouts SET total=100 WHERE id=$1', [co.id]);
  await assert.rejects(() => checkout.createCheckoutPaymentOrder(user, co.id), /does not match/);
  assert.equal(fake.orders.size, 0);
});

test('stale prices and invalid lines are rejected', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const user = await makeUser();
  await assert.rejects(() => start(user, [{ productId: a.productId, quantity: 1, version: 7 }]), /price has changed/);
  await assert.rejects(() => checkout.createCheckout(user, [], randomUUID()), /empty/);
  await assert.rejects(() => checkout.createCheckout(user, [{ productId: a.productId, quantity: 1, version: 1 }, { productId: a.productId, quantity: 2, version: 1 }], randomUUID()), /only once/);
  await assert.rejects(() => checkout.createCheckout(user, [{ productId: a.productId, quantity: 0, version: 1 }], randomUUID()), /valid ticket quantity/);
});

test('webhook: duplicate (×5, concurrent) settles once; delayed webhook after the callback is a no-op', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 2 }]);
  const p = fake.pay(order.orderId);
  const { body, signature } = webhook('payment.captured', p);
  await Promise.allSettled(Array.from({ length: 5 }, () => payments.ingestRazorpayWebhook(body, signature)));
  assert.equal((await query('SELECT count(*)::int n FROM payments'))[0].n, 1);
  assert.equal(await ticketCount(co.id), 3);
  const late = await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  assert.equal(late.status, 'CONFIRMED');
  assert.equal(await ticketCount(co.id), 3, 'no duplicate tickets');
});

test('browser closed after paying, no webhook → reconciliation confirms the whole cart', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  fake.pay(order.orderId);
  await query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE checkout_id=$1', [co.id]);
  const summary = await payments.reconcileOpenRazorpayPayments();
  assert.equal(summary.settled, 1);
  assert.deepEqual((await bookingsOf(co.id)).map((x) => x.status), ['CONFIRMED', 'CONFIRMED']);
});

test('N: late payment with seats left → all lines confirmed', { skip }, async () => {
  const a = await makeShow({ price: 50000, allocation: 3 });
  const b = await makeShow({ price: 25000, allocation: 3 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  await query("UPDATE bookings SET expires_at=now() - interval '1 second' WHERE checkout_id=$1", [co.id]);
  await commerce.expireHolds();
  assert.equal((await payCallback(user, order.orderId)).status, 'CONFIRMED');
  assert.equal((await pool(a.poolId)).committed, 1);
});

test('N: late payment when one line sold out → nothing confirmed, full refund (all-or-nothing), no false "confirmed"', { skip }, async () => {
  const a = await makeShow({ price: 50000, allocation: 3 });
  const b = await makeShow({ price: 25000, allocation: 1 });
  const user = await makeUser();
  const rival = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  await query("UPDATE bookings SET expires_at=now() - interval '1 second' WHERE checkout_id=$1", [co.id]);
  await commerce.expireHolds();
  const won = await startAndOrder(rival, [{ productId: b.productId, quantity: 1 }]);
  await payCallback(rival, won.order.orderId);
  const res = await payCallback(user, order.orderId);
  assert.equal(res.status, 'REFUND_REQUIRED');
  assert.equal(await ticketCount(co.id), 0, 'no tickets for an unfulfilled cart');
  assert.deepEqual(await pool(a.poolId), { allocation: 3, held: 0, committed: 0 }, 'line A not kept either');
  assert.deepEqual(await pool(b.poolId), { allocation: 1, held: 0, committed: 1 }, 'never oversold');
  const refunds = await query<{ amount: number }>('SELECT r.amount FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE b.checkout_id=$1', [co.id]);
  assert.equal(refunds.reduce((s, r) => s + Number(r.amount), 0), 75000, 'refunds sum to the full payment');
  await jobs.processJobs();
  const userRefunds = [...fake.refunds.values()].filter((r) => fake.payments.get(r.payment_id)?.order_id === order.orderId);
  assert.equal(userRefunds.reduce((s, r) => s + r.amount, 0), 75000);
  assert.deepEqual((await bookingsOf(co.id)).map((x) => x.status), ['REFUNDED', 'REFUNDED']);
  // client contract: REFUND_REQUIRED is never treated as success
  const { assertBookingIssued } = await import('../src/lib/razorpay-checkout');
  assert.throws(() => assertBookingIssued(res), /REFUND_REQUIRED/);
});

test('a second payment on an already-settled cart is refunded in full', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }]);
  await payCallback(user, order.orderId);
  const extra = fake.pay(order.orderId);
  const { body, signature } = webhook('payment.captured', extra);
  await payments.ingestRazorpayWebhook(body, signature);
  assert.equal(await ticketCount(co.id), 1);
  const r = await query<{ amount: number }>('SELECT r.amount FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.provider_payment_id=$1', [extra.id]);
  assert.deepEqual(r.map((x) => Number(x.amount)), [50000]);
});

test('show cancelled for one line of a paid cart → that booking’s price is refunded once; the other line stays valid', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const user = await makeUser();
  const owner = await makeUser('owner');
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  await payCallback(user, order.orderId);
  const { updateShow } = await import('../src/lib/catalogue');
  await updateShow(owner, a.showId, { status: 'CANCELLED', confirmCancellation: true });
  await updateShow(owner, a.showId, { status: 'CANCELLED', confirmCancellation: true });
  const rows = await bookingsOf(co.id);
  assert.deepEqual(rows.map((x) => [Number(x.total), x.status]), [[50000, 'CANCELLED'], [25000, 'CONFIRMED']]);
  const refunds = await query<{ amount: number }>('SELECT r.amount FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE b.checkout_id=$1', [co.id]);
  assert.deepEqual(refunds.map((r) => Number(r.amount)), [50000]);
  await jobs.processJobs();
  assert.equal(fake.refunds.size, 1);
  assert.equal([...fake.refunds.values()][0].amount, 50000, 'partial refund of the shared payment');
});

test('show cancelled while the cart is unpaid → the whole cart is released; a late payment is refunded in full', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const user = await makeUser();
  const owner = await makeUser('owner');
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  const { updateShow } = await import('../src/lib/catalogue');
  await updateShow(owner, a.showId, { status: 'CANCELLED', confirmCancellation: true });
  assert.deepEqual((await bookingsOf(co.id)).map((x) => x.status), ['CANCELLED', 'CANCELLED']);
  assert.equal((await pool(b.poolId)).held, 0, 'the other line is released too');
  const res = await payCallback(user, order.orderId);
  assert.notEqual(res.status, 'CONFIRMED');
  const refunded = await query<{ n: number }>('SELECT COALESCE(sum(r.amount),0)::int n FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE b.checkout_id=$1', [co.id]);
  assert.equal(refunded[0].n, 75000);
});

test('paying a checkout booking from its ticket page pays the whole cart (same order)', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  const lineA = (await bookingsOf(co.id))[0];
  const viaBooking = await payments.createPaymentOrder(user, lineA.id);
  assert.equal(viaBooking.orderId, order.orderId);
  assert.equal(viaBooking.amount, 75000);
});

test('O/P: existing single-booking purchase still works, and checkout tickets are retrievable by their owner only', { skip }, async () => {
  const a = await makeShow({ price: 50000 });
  const user = await makeUser();
  const hold = (await commerce.reserve(user, { productId: a.productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  const single = await payments.createPaymentOrder(user, hold.id);
  assert.equal((await payCallback(user, single.orderId)).status, 'CONFIRMED');
  const b = await makeShow({ price: 25000 });
  const { co, order } = await startAndOrder(user, [{ productId: b.productId, quantity: 2 }]);
  await payCallback(user, order.orderId);
  const lineId = (await bookingsOf(co.id))[0].id;
  const owned = (await commerce.ownedBookings(user.id, lineId))[0] as { tickets: unknown[]; checkout_reference: string };
  assert.equal(owned.tickets.length, 2);
  assert.equal(owned.checkout_reference, co.reference);
  assert.deepEqual(await commerce.ownedBookings((await makeUser()).id, lineId), []);
  const { ticketPass } = await import('../src/lib/tickets');
  const ticketId = (await query<{ id: string }>('SELECT id FROM tickets WHERE booking_id=$1 LIMIT 1', [lineId]))[0].id;
  assert.ok((await ticketPass(user, ticketId)).qr);
  const other = await makeUser();
  await assert.rejects(() => ticketPass(other, ticketId));
});

test('Q: a ticket bought through a cart checkout is admitted at the gate once', { skip }, async () => {
  const s = await makeShow({ price: 50000, startsInMinutes: 30 });
  const user = await makeUser();
  const { co, order } = await startAndOrder(user, [{ productId: s.productId, quantity: 1 }]);
  await payCallback(user, order.orderId);
  const staff = await import('../src/lib/staff');
  const scanner = await staff.upsertStaff({ contact: 'door@tickets.test', role: 'scanner' });
  const { decrypt } = await import('../src/lib/security');
  const enc = (await query<{ encrypted_token: string }>(
    'SELECT c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1', [co.id]))[0].encrypted_token;
  const { admit } = await import('../src/lib/admission');
  const who = { id: scanner.id, contact: scanner.contact, name: '', role: 'scanner' as const };
  const scan = () => admit(who, { requestId: randomUUID(), ticketToken: decrypt(enc), showId: s.showId, gateId: 'gate-one', deviceId: 'gate-one' });
  assert.equal((await scan()).result, 'ADMITTED');
  assert.match((await scan()).reason ?? '', /already admitted/);
});

test('local development adapter confirms a cart checkout (dev mode only, never on a public host)', { skip }, async () => {
  const saved = { APP_MODE: process.env.APP_MODE, APP_URL: process.env.APP_URL, PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER, OTP_PROVIDER: process.env.OTP_PROVIDER };
  Object.assign(process.env, { APP_MODE: 'development', APP_URL: 'http://localhost:3000', PAYMENT_PROVIDER: 'development', OTP_PROVIDER: 'development' });
  try {
    const a = await makeShow({ price: 50000 });
    const b = await makeShow({ price: 25000 });
    const user = await makeUser();
    const { co, order } = await startAndOrder(user, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
    assert.equal(order.provider, 'development');
    const res = await payments.confirmDevelopmentPayment(user, co.id, order.orderId);
    assert.equal(res.status, 'CONFIRMED');
    assert.equal(await ticketCount(co.id), 2);
  } finally {
    Object.assign(process.env, saved);
  }
});
