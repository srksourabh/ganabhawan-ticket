/**
 * Post-payment lifecycle (staging report, Oct 2026): after a successful
 * Razorpay TEST payment the cart still offered "Continue to payment".
 * The server state after payment, what the cart reconciles against, the
 * single receipt/email, and the gate scan of a paid ticket are pinned here.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv, webhook } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let jobs: typeof import('../src/lib/jobs');
let auth: typeof import('../src/lib/auth');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  jobs = await import('../src/lib/jobs');
  auth = await import('../src/lib/auth');
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

async function twoLineCart(user: User, opts: { startsInMinutes?: number } = {}) {
  const a = await makeShow({ price: 50000, title: 'Play A', ...opts });
  const b = await makeShow({ price: 25000, title: 'Play B', ...opts });
  const co = await checkout.createCheckout(user, [
    { productId: a.productId, quantity: 1, version: 1 },
    { productId: b.productId, quantity: 1, version: 1 },
  ], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  return { a, b, co, order };
}

const callback = (user: User, orderId: string, paymentId: string) =>
  payments.verifyRazorpayCallback({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: checkoutSignature(orderId, paymentId) }, user);

test('after a successful payment the server state is final: checkout CONFIRMED, payment captured, every booking confirmed with tickets and QR credentials', { skip }, async () => {
  const user = await makeUser();
  const { co, order } = await twoLineCart(user);
  const p = fake.pay(order.orderId);
  const res = await callback(user, order.orderId, p.id);
  assert.equal(res.status, 'CONFIRMED');
  const state = await query<Record<string, unknown>>(`
    SELECT (SELECT count(*)::int FROM payments WHERE checkout_id=$1 AND state='CAPTURED') AS captured,
           (SELECT count(*)::int FROM payments WHERE checkout_id=$1 AND provider_payment_id=$2 AND provider_order_id=$3) AS matched,
           (SELECT count(*)::int FROM bookings WHERE checkout_id=$1 AND status<>'CONFIRMED') AS unconfirmed,
           (SELECT count(*)::int FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND t.status='ACTIVE') AS tickets,
           (SELECT count(*)::int FROM credentials c JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND c.status='ACTIVE') AS qr,
           (SELECT count(*)::int FROM payment_attempts WHERE checkout_id=$1 AND next_reconcile_at IS NOT NULL) AS still_reconciling`,
    [co.id, p.id, order.orderId]);
  assert.deepEqual(state[0], { captured: 1, matched: 1, unconfirmed: 0, tickets: 2, qr: 2, still_reconciling: 0 });
  // What the cart asks the server (GET /api/checkouts/:id): CONFIRMED, so "Continue to payment" disappears.
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
});

test('refresh and sign-out/sign-in: the same user still sees the paid checkout; another user cannot see it', { skip }, async () => {
  const user = await makeUser();
  const { co, order } = await twoLineCart(user);
  await callback(user, order.orderId, fake.pay(order.orderId).id);
  for (let i = 0; i < 3; i += 1) assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED'); // refreshes
  // Sign out (session revoked) and sign in again (new session, same account).
  await query("INSERT INTO sessions(digest,user_id,expires_at) VALUES('old-digest',$1,now()+interval '1 hour')", [user.id]);
  await query("DELETE FROM sessions WHERE digest='old-digest'");
  const { token, hash } = await import('../src/lib/security');
  const fresh = token();
  await query("INSERT INTO sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hash(fresh), user.id]);
  const again = await auth.sessionUser(fresh);
  assert.equal(again?.id, user.id);
  assert.equal((await checkout.checkoutReceipt(again!.id, co.id)).status, 'CONFIRMED');
  const stranger = await makeUser();
  await assert.rejects(() => checkout.checkoutReceipt(stranger.id, co.id), /not found/i, 'a different account on the same browser gets 404 (the cart forgets it)');
});

test('browser never sees the result (modal lost / tab closed): webhook confirms, and the cart’s server check reports CONFIRMED', { skip }, async () => {
  const user = await makeUser();
  const { co, order } = await twoLineCart(user);
  const p = fake.pay(order.orderId);
  const { body, signature } = webhook('payment.captured', p);
  await payments.ingestRazorpayWebhook(body, signature); // no browser callback at all
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
  // And with no webhook either: reconciliation gets there.
  const user2 = await makeUser();
  const two = await twoLineCart(user2);
  fake.pay(two.order.orderId);
  await query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE checkout_id=$1', [two.co.id]);
  await payments.reconcileOpenRazorpayPayments();
  assert.equal((await checkout.checkoutReceipt(user2.id, two.co.id)).status, 'CONFIRMED');
});

test('the cart keeps watching an open, then expired, checkout and removes exactly its lines when a late payment confirms it', { skip }, async () => {
  const { reconcileCart } = await import('../src/lib/cart-reconcile');
  const user = await makeUser();
  const { a, b, co, order } = await twoLineCart(user);
  const pending = { id: co.id, reference: co.reference, lines: [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }] };
  const cart = [...pending.lines, { productId: 'added-later', quantity: 2 }];
  const step = async () => reconcileCart(cart, pending, (await checkout.checkoutReceipt(user.id, co.id)).status);

  // Regression: the receipt (what the cart polls) reported every open checkout as EXPIRED, so the cart forgot it.
  let r = await step();
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'PAYMENT_PENDING');
  assert.deepEqual([r.items, r.keepPending], [cart, true]);

  await query("UPDATE bookings SET expires_at=now() - interval '1 second' WHERE checkout_id=$1", [co.id]);
  r = await step();
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'EXPIRED');
  assert.deepEqual([r.items, r.keepPending], [cart, true], 'expired is not final: nothing removed, still watched');

  // UPI capture lands after the hold lapsed; seats remain, so reconciliation confirms the whole cart.
  fake.pay(order.orderId);
  await query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE checkout_id=$1', [co.id]);
  await payments.reconcileOpenRazorpayPayments();
  r = await step();
  assert.equal(r.outcome, 'paid');
  assert.deepEqual(r.items, [{ productId: 'added-later', quantity: 2 }], 'paid lines removed, the unrelated line stays');
  assert.equal(r.keepPending, false);
});

test('callback + webhook + reconciliation all processing the same payment: one payment row, no duplicate tickets, ONE confirmation email', { skip }, async () => {
  const user = await makeUser();
  const { co, order } = await twoLineCart(user);
  const p = fake.pay(order.orderId);
  const { body, signature } = webhook('payment.captured', p);
  await Promise.allSettled([
    callback(user, order.orderId, p.id),
    payments.ingestRazorpayWebhook(body, signature),
    payments.ingestRazorpayWebhook(body, signature),
    payments.syncRazorpayPayment(user, co.id),
  ]);
  await query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE checkout_id=$1', [co.id]);
  await payments.reconcileOpenRazorpayPayments();
  await callback(user, order.orderId, p.id); // a late duplicate callback
  assert.equal((await query('SELECT count(*)::int n FROM payments'))[0].n, 1);
  assert.equal((await query('SELECT count(*)::int n FROM tickets'))[0].n, 2);
  assert.equal((await query("SELECT count(*)::int n FROM jobs WHERE kind='DELIVERY'"))[0].n, 1, 'one consolidated delivery job');
  await jobs.processJobs();
  await jobs.processJobs();
  assert.equal(fake.emails.filter((m) => m.to === user.contact).length, 1, 'exactly one confirmation email');
  assert.equal((await query('SELECT count(*)::int n FROM refunds'))[0].n, 0, 'no spurious refund');
});

async function scannerFor(email: string) {
  const staff = await import('../src/lib/staff');
  const s = await staff.upsertStaff({ contact: email, role: 'scanner' });
  return { id: s.id, contact: s.contact, name: '', role: 'scanner' as const };
}
async function qrTokens(checkoutId: string) {
  const { decrypt } = await import('../src/lib/security');
  const rows = await query<{ encrypted_token: string; show_id: string }>(
    `SELECT c.encrypted_token, e.show_id FROM credentials c JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id
     JOIN entitlements e ON e.ticket_id=t.id WHERE b.checkout_id=$1 AND c.status='ACTIVE'`, [checkoutId]);
  return rows.map((r) => ({ token: decrypt(r.encrypted_token), showId: r.show_id }));
}

test('scanner: a paid ticket is admitted once; second scan rejected; wrong show rejected; fake QR rejected', { skip }, async () => {
  const user = await makeUser();
  const { a, b, co, order } = await twoLineCart(user, { startsInMinutes: 30 });
  await callback(user, order.orderId, fake.pay(order.orderId).id);
  const door = await scannerFor('door1@tickets.test');
  const { admit } = await import('../src/lib/admission');
  const [ticketA] = (await qrTokens(co.id)).filter((t) => t.showId === a.showId);
  const scan = (token: string, showId: string) => admit(door, { requestId: randomUUID(), ticketToken: token, showId, gateId: 'gate-one', deviceId: 'gate-one' });
  assert.equal((await scan(ticketA.token, a.showId)).result, 'ADMITTED');
  const second = await scan(ticketA.token, a.showId);
  assert.equal(second.result, 'DENIED');
  assert.match(second.reason ?? '', /already admitted/);
  assert.match((await scan(ticketA.token, b.showId)).reason ?? '', /No active entitlement/);
  assert.equal((await scan('not-a-real-qr', a.showId)).result, 'UNKNOWN');
  assert.equal((await query('SELECT count(*)::int n FROM admissions'))[0].n, 1);
});

test('scanner: two scanners scanning the same ticket at the same moment → exactly one admission', { skip }, async () => {
  const user = await makeUser();
  const { a, co, order } = await twoLineCart(user, { startsInMinutes: 30 });
  await callback(user, order.orderId, fake.pay(order.orderId).id);
  const door1 = await scannerFor('door-a@tickets.test');
  const door2 = await scannerFor('door-b@tickets.test');
  const { admit } = await import('../src/lib/admission');
  const [ticketA] = (await qrTokens(co.id)).filter((t) => t.showId === a.showId);
  const results = await Promise.all([door1, door2, door1, door2].map((who) =>
    admit(who, { requestId: randomUUID(), ticketToken: ticketA.token, showId: a.showId, gateId: 'gate-one', deviceId: 'gate-one' })));
  assert.equal(results.filter((r) => r.result === 'ADMITTED').length, 1);
  assert.equal((await query('SELECT count(*)::int n FROM admissions'))[0].n, 1);
});

test('scanner: an unpaid cart has no scannable QR; a refunded (show-cancelled) ticket is rejected; customers cannot scan', { skip }, async () => {
  const user = await makeUser();
  const unpaid = await twoLineCart(user, { startsInMinutes: 30 });
  assert.equal((await qrTokens(unpaid.co.id)).length, 0, 'no credential exists before payment');
  const buyer = await makeUser();
  const paid = await twoLineCart(buyer, { startsInMinutes: 40 });
  await callback(buyer, paid.order.orderId, fake.pay(paid.order.orderId).id);
  const [ticketA] = (await qrTokens(paid.co.id)).filter((t) => t.showId === paid.a.showId);
  const { updateShow } = await import('../src/lib/catalogue');
  await updateShow(await makeUser('owner'), paid.a.showId, { status: 'CANCELLED', confirmCancellation: true });
  const door = await scannerFor('door3@tickets.test');
  const { admit } = await import('../src/lib/admission');
  const res = await admit(door, { requestId: randomUUID(), ticketToken: ticketA.token, showId: paid.a.showId, gateId: 'gate-one', deviceId: 'gate-one' });
  assert.notEqual(res.result, 'ADMITTED');
  await assert.rejects(() => admit(buyer, { requestId: randomUUID(), ticketToken: ticketA.token, showId: paid.a.showId, gateId: 'gate-one', deviceId: 'gate-one' }), /permission/);
  // The other line of the shared payment is still valid and refund is only for A.
  assert.equal((await checkout.checkoutReceipt(buyer.id, paid.co.id)).refunds.reduce((s, r) => s + r.amount, 0), 50000);
});
