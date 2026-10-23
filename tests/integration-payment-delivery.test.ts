/**
 * Razorpay refusals, ticket email delivery and the DEMO email preview.
 *  - Production symptom: every checkout showed "The payment service is unavailable right now"
 *    and no Razorpay order was ever created: Razorpay refused the request (any non-429 HTTP
 *    error). The customer message stays generic, but Razorpay's own reason (e.g. 401
 *    "Authentication failed") is now recorded for Admin → Ops (no secret), and a 401 is critical.
 *  - Key id / secrets pasted with surrounding whitespace authenticate (the config check already
 *    trimmed them; the requests did not, so Razorpay refused them).
 *  - Ticket emails: only after a verified payment; one customer email + one organisation copy
 *    (default samatatsanskritiuttarpara2000@gmail.com, TICKET_COPY_EMAIL overrides), never repeated
 *    by webhook redelivery; failed or pending payments send nothing.
 *  - The DEMO preview renders the real template with sample data and sends/stores nothing.
 * Real code on the local test database; Razorpay and Resend are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, TEST_SECRETS, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv as liveStagingEnv, webhook } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const ORG_DEFAULT = 'samatatsanskritiuttarpara2000@gmail.com';
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let razorpay: typeof import('../src/lib/razorpay');
let jobs: typeof import('../src/lib/jobs');
let ops: typeof import('../src/lib/ops');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  liveStagingEnv();
  fake.install();
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  razorpay = await import('../src/lib/razorpay');
  jobs = await import('../src/lib/jobs');
  ops = await import('../src/lib/ops');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  liveStagingEnv();
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  liveStagingEnv();
  fake.reset();
  // Razorpay checks the key pair, exactly like production.
  fake.acceptedKeys = { id: TEST_SECRETS.RAZORPAY_KEY_ID, secret: TEST_SECRETS.RAZORPAY_KEY_SECRET };
  await resetDatabase();
});

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);
const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });
const ticketEmails = () => fake.emails.filter((e) => /tickets - /.test(e.subject));
async function order(user: User, show: { productId: string }, quantity = 2) {
  const co = await checkout.createCheckout(user, [line(show, quantity)], randomUUID());
  return { co, order: await checkout.createCheckoutPaymentOrder(user, co.id) };
}
async function pay(user: User, orderId: string) {
  const p = fake.pay(orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(orderId, p.id) }, user);
  return p;
}

// ---- RAZORPAY REFUSALS ---------------------------------------------------------------------------------

test('correct Test Mode key pair: order created, payment verified, booking confirmed', { skip }, async () => {
  const show = await makeShow();
  const buyer = await makeUser();
  const { co, order: o } = await order(buyer, show);
  assert.match(o.orderId, /^order_/);
  await pay(buyer, o.orderId);
  assert.equal((await checkout.checkoutReceipt(buyer.id, co.id)).status, 'CONFIRMED');
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action='payment.provider.error'"), 0);
});

test('mismatched secret: Razorpay 401 → same customer message, attempt FAILED, hold kept, reason recorded for Ops (no secret), no email', { skip }, async () => {
  const show = await makeShow({ allocation: 5 });
  const buyer = await makeUser();
  process.env.RAZORPAY_KEY_SECRET = 'a-secret-from-another-key';
  const co = await checkout.createCheckout(buyer, [line(show, 2)], randomUUID());
  await assert.rejects(checkout.createCheckoutPaymentOrder(buyer, co.id), (e: unknown) =>
    (e as { message?: string; code?: string }).message === 'The payment service is unavailable right now. Please try again in a moment.' && (e as { code?: string }).code === 'PROVIDER_ERROR');
  assert.equal(fake.count('POST /orders'), 0, 'refused at the first call (GET /orders?receipt=…)');
  assert.equal(await count("SELECT count(*)::int n FROM payment_attempts WHERE checkout_id=$1 AND state='FAILED' AND provider_order_id IS NULL", [co.id]), 1);
  assert.equal(await count("SELECT count(*)::int n FROM bookings WHERE checkout_id=$1 AND status IN ('HELD','PAYMENT_PENDING') AND expires_at>now()", [co.id]), 1, 'the hold stays until it expires');
  assert.equal(await count('SELECT held::int n FROM pools WHERE id=$1', [show.poolId]), 2, 'its seats stay held (released by the normal expiry)');
  const recorded = (await query<{ detail: Record<string, unknown> }>("SELECT detail FROM audit_events WHERE action='payment.provider.error'"))[0].detail;
  assert.deepEqual(recorded, { status: 401, endpoint: 'GET /orders', code: 'BAD_REQUEST_ERROR', reason: 'NA', description: 'Authentication failed' });
  assert.ok(!JSON.stringify(recorded).includes('another-key') && !JSON.stringify(recorded).includes(TEST_SECRETS.RAZORPAY_KEY_ID), 'no key or secret stored');
  const status = await ops.opsStatus();
  assert.equal(status.provider.failures24h, 1);
  assert.ok(status.critical.some((c) => /Razorpay refused the API keys \(401 Authentication failed/.test(c) && /matching pair/.test(c)), status.critical.join(' | '));
  await jobs.processJobs();
  assert.equal(ticketEmails().length, 0);
});

test('key id and secrets pasted with surrounding whitespace still authenticate (as the config check already accepted them)', { skip }, async () => {
  process.env.RAZORPAY_KEY_ID = ` ${TEST_SECRETS.RAZORPAY_KEY_ID}\n`;
  process.env.RAZORPAY_KEY_SECRET = `${TEST_SECRETS.RAZORPAY_KEY_SECRET}\r\n`;
  process.env.RAZORPAY_WEBHOOK_SECRET = `${TEST_SECRETS.RAZORPAY_WEBHOOK_SECRET} \n`;
  assert.equal(razorpay.razorpayKeyId(), TEST_SECRETS.RAZORPAY_KEY_ID, 'the browser checkout gets the clean key id');
  const show = await makeShow();
  const buyer = await makeUser();
  const { co, order: o } = await order(buyer, show);
  await pay(buyer, o.orderId);
  assert.equal((await checkout.checkoutReceipt(buyer.id, co.id)).status, 'CONFIRMED');
  const { body, signature } = webhook('payment.captured', { id: 'pay_x', order_id: 'order_x', amount: 1, currency: 'INR', status: 'captured' });
  assert.doesNotThrow(() => razorpay.assertWebhookSignature(body, signature), 'webhook signature verified with the trimmed secret');
  assert.throws(() => razorpay.assertWebhookSignature(body, 'forged'), /Invalid webhook signature/);
});

test('other refusals (provider down) are a warning with the reason, not a key problem', { skip }, async () => {
  const show = await makeShow();
  const buyer = await makeUser();
  fake.down = true;
  const co = await checkout.createCheckout(buyer, [line(show)], randomUUID());
  await assert.rejects(checkout.createCheckoutPaymentOrder(buyer, co.id), /payment service is unavailable/);
  const status = await ops.opsStatus();
  assert.ok(!status.critical.some((c) => /API keys/.test(c)));
  assert.ok(status.warnings.some((w) => /Razorpay refused 1 request\(s\) in 24 h; latest 503 on GET \/orders: +Service unavailable/.test(w)), status.warnings.join(' | '));
  fake.down = false;
  // Retrying after the provider recovers works (a new attempt, the same hold).
  assert.match((await checkout.createCheckoutPaymentOrder(buyer, co.id)).orderId, /^order_/);
});

// ---- TICKET EMAIL DELIVERY -------------------------------------------------------------------------------

test('verified payment: one customer ticket email + one organisation copy to the default address; the customer never sees it', { skip }, async () => {
  delete process.env.TICKET_COPY_EMAIL;
  const show = await makeShow();
  const buyer = await makeUser();
  const { order: o } = await order(buyer, show, 2);
  await pay(buyer, o.orderId);
  await jobs.processJobs();
  const customer = ticketEmails().filter((e) => e.to === buyer.contact);
  const copy = ticketEmails().filter((e) => e.to === ORG_DEFAULT);
  assert.equal(customer.length, 1);
  assert.equal(copy.length, 1);
  assert.match(copy[0].subject, /^\[Copy\] /);
  assert.ok(!customer[0].html!.includes(ORG_DEFAULT) && !customer[0].text.includes(ORG_DEFAULT));
  assert.equal((customer[0].html!.match(/alt="QR code for ticket/g) ?? []).length, 2, 'a QR per ticket');
  process.env.TICKET_COPY_EMAIL = 'office@tickets.test';
  const { order: o2 } = await order(buyer, show, 1);
  await pay(buyer, o2.orderId);
  await jobs.processJobs();
  assert.equal(fake.emails.filter((e) => e.to === 'office@tickets.test').length, 1, 'TICKET_COPY_EMAIL overrides the default');
});

test('failed and pending payments send no ticket email and issue no ticket', { skip }, async () => {
  const show = await makeShow();
  const failedBuyer = await makeUser();
  const pendingBuyer = await makeUser();
  const failed = await order(failedBuyer, show, 1);
  fake.pay(failed.order.orderId, { status: 'failed' });
  await order(pendingBuyer, show, 1); // order created, never paid
  await query("UPDATE payment_attempts SET next_reconcile_at=now()-interval '1 minute'");
  await payments.reconcileOpenRazorpayPayments(10);
  await jobs.processJobs();
  assert.equal(ticketEmails().length, 0);
  assert.equal(await count("SELECT count(*)::int n FROM jobs WHERE kind='DELIVERY'"), 0);
  assert.equal(await count('SELECT count(*)::int n FROM tickets'), 0);
});

test('webhook redelivered 3 times after the browser callback: still one customer email and one organisation copy', { skip }, async () => {
  delete process.env.TICKET_COPY_EMAIL;
  const show = await makeShow();
  const buyer = await makeUser();
  const { order: o } = await order(buyer, show, 1);
  const p = await pay(buyer, o.orderId);
  for (let i = 0; i < 3; i++) {
    const { body, signature } = webhook('payment.captured', { ...p }, 'payment', 'evt_' + randomUUID());
    await payments.ingestRazorpayWebhook(body, signature);
    await jobs.processJobs();
  }
  assert.equal(ticketEmails().filter((e) => e.to === buyer.contact).length, 1);
  assert.equal(ticketEmails().filter((e) => e.to === ORG_DEFAULT).length, 1);
});

// ---- DEMO PREVIEW ---------------------------------------------------------------------------------------

test('DEMO email preview: full customer email with demo QR codes; sends nothing, stores nothing', { skip }, async () => {
  const { renderDemoTicketEmail, DEMO_BANNER, DEMO_QR_LABEL } = await import('../scripts/preview-ticket-email');
  const callsBefore = fake.calls.length;
  const { subject, html } = await renderDemoTicketEmail();
  assert.match(subject, /^\[DEMO\] /);
  assert.ok(html.includes(DEMO_BANNER));
  assert.equal(html.split(DEMO_QR_LABEL).length - 1, 2, 'each QR labelled DEMO');
  for (const text of ['Macbeth 2.0', 'Premier', '19 Dec 2026', 'Ganabhawan', 'DEMO-GF-2026', 'DEMO-TKT-0001', 'DEMO-TKT-0002', '2 &times; ₹500', '₹1,000', 'Entry instructions']) {
    assert.ok(html.includes(text), text);
  }
  assert.equal((html.match(/<img [^>]*src="data:image\/png;base64,/g) ?? []).length, 3, 'logo + 2 QR codes inline: nothing fetched');
  assert.ok(!html.includes('/api/ticket-qr/'), 'no real ticket QR link');
  assert.equal(fake.calls.length, callsBefore, 'no email or payment call');
  assert.equal(await count('SELECT count(*)::int n FROM bookings') + await count('SELECT count(*)::int n FROM payments'), 0);
});
