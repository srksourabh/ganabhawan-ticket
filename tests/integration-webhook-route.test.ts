/**
 * POST /api/payments/webhook/razorpay through the real route handler: what
 * Razorpay's dashboard delivery log would show for each configuration mistake.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, TEST_SECRETS, makeShow, makeUser, resetDatabase, useLiveStagingEnv, webhook } from './helpers/fixtures';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let POST: typeof import('../app/api/payments/webhook/razorpay/route').POST;
let checkout: typeof import('../src/lib/checkout');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  ({ POST } = await import('../app/api/payments/webhook/razorpay/route'));
  checkout = await import('../src/lib/checkout');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  fake.reset();
  process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRETS.RAZORPAY_WEBHOOK_SECRET;
  await resetDatabase();
});

const deliver = (body: string, signature?: string) =>
  POST(new Request('https://staging.tickets.test/api/payments/webhook/razorpay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature === undefined ? {} : { 'X-Razorpay-Signature': signature }) },
    body,
  }));
const stored = async () => (await query<{ n: number }>('SELECT count(*)::int n FROM webhook_events'))[0].n;

test('webhook route: missing secret 503, missing/forged signature 400 — nothing stored, nothing settled', { skip }, async () => {
  const user = await makeUser();
  const show = await makeShow();
  const co = await checkout.createCheckout(user, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  const { body, signature } = webhook('payment.captured', p);

  assert.equal((await deliver(body)).status, 400, 'no signature header');
  assert.equal((await deliver(body, 'deadbeef')).status, 400, 'forged signature');
  const otherSecret = webhook('payment.captured', p); // signed with the right secret but body changed below
  assert.equal((await deliver(otherSecret.body.replace('"captured"', '"authorized"'), otherSecret.signature)).status, 400, 'tampered body');
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  assert.equal((await deliver(body, signature)).status, 503, 'secret not configured on the Worker');
  process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRETS.RAZORPAY_WEBHOOK_SECRET;

  assert.equal(await stored(), 0);
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'PAYMENT_PENDING');
});

test('webhook route: a correctly signed payment.captured is stored and confirms the checkout; a redelivery is a no-op', { skip }, async () => {
  const user = await makeUser();
  const show = await makeShow();
  const co = await checkout.createCheckout(user, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  const { body, signature } = webhook('payment.captured', p, 'payment', 'evt_route_1');

  const first = await deliver(body, signature);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { processed: true });
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
  const again = await deliver(body, signature);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { duplicate: true });
  assert.equal(await stored(), 1);
  assert.equal((await query<{ n: number }>('SELECT count(*)::int n FROM payments'))[0].n, 1);
  assert.equal((await query<{ n: number }>('SELECT count(*)::int n FROM tickets'))[0].n, 1);
});
