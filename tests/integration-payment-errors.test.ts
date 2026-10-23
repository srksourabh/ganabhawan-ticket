/**
 * Customer-facing payment errors: the payment provider's own text (e.g. Razorpay's
 * "Too Many Requests") never reaches the customer, and nothing is lost: the retry works.
 * Real checkout and payment code on the local test database; Razorpay is the in-process fake.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let auth: typeof import('../src/lib/auth');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  auth = await import('../src/lib/auth');
  checkout = await import('../src/lib/checkout');
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

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);
const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });
async function guest(name: string, mail: string, phone = '+919876500001', presented = '') {
  const opened = await auth.openGuestSession(name, mail, phone, presented);
  return { token: opened.sessionToken, user: (await auth.guestSessionUser(opened.sessionToken))!, reused: opened.reused };
}
async function payCheckout(user: User, checkoutId: string) {
  const order = await checkout.createCheckoutPaymentOrder(user, checkoutId);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
}

test('Razorpay "Too Many Requests" never reaches the customer; nothing is lost and the retry works', { skip }, async () => {
  const show = await makeShow();
  const g = await guest('E', 'e1@tickets.test', '+919876500010');
  const co = await checkout.createCheckout(g.user, [line(show)], randomUUID());
  fake.throttled = true;
  await assert.rejects(checkout.createCheckoutPaymentOrder(g.user, co.id), (e: unknown) => {
    const err = e as { message: string; status?: number; code?: string };
    return err.status === 503 && err.code === 'PROVIDER_BUSY' && /busy/.test(err.message) && !/Too Many Requests/i.test(err.message);
  });
  fake.throttled = false;
  await payCheckout(g.user, co.id);
  assert.equal(await count("SELECT count(*)::int n FROM bookings WHERE checkout_id=$1 AND status='CONFIRMED'", [co.id]), 1);
});
