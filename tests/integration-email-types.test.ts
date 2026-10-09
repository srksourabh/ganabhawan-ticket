/**
 * Every email the application sends, with customer mobile features OFF (the
 * email-first launch setting) and no MSG91 settings:
 *   1. sign-in code            (auth.ts requestOtp)
 *   2. checkout confirmation   (DELIVERY job, checkout.ts receiptText)
 *   3. single-booking confirmation (DELIVERY job, tickets.ts bookingConfirmation)
 *   4. "resend tickets"        (tickets.ts deliverBooking)
 *   5. show-cancellation notice (NOTICE job, commerce.ts cancelShowBookings)
 * There are no refund-status, failed-payment or staff emails in the code base.
 * Resend is the in-process fake (it honours Idempotency-Key like the real API);
 * these tests prove what the app hands to the provider, not inbox delivery.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const CARDS = 'Please collect your physical cards before the show.';
const BASE = 'https://staging.tickets.test';
let auth: typeof import('../src/lib/auth');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let jobs: typeof import('../src/lib/jobs');
let catalogue: typeof import('../src/lib/catalogue');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  process.env.MOBILE_PHONE_NUMBER_ENABLED = 'false';
  for (const name of ['SMS_PROVIDER', 'MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID', 'MSG91_TEMPLATE_ID']) delete process.env[name];
  fake.install();
  auth = await import('../src/lib/auth');
  checkout = await import('../src/lib/checkout');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  jobs = await import('../src/lib/jobs');
  catalogue = await import('../src/lib/catalogue');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  delete process.env.MOBILE_PHONE_NUMBER_ENABLED;
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  fake.reset();
  await resetDatabase();
});

const mailTo = (to: string) => fake.emails.filter((e) => e.to === to);
const emailUser = (name: string) => makeUser('customer', `${name}-${randomUUID().slice(0, 6)}@tickets.test`, { mobile: null });
async function tick() {
  await jobs.processJobs();
  await query("UPDATE jobs SET run_at=now() WHERE state='PENDING'");
  await jobs.processJobs();
}
/** A single (non-cart) booking: hold → payment order → signed callback. */
async function buySingle(user: User, productId: string, quantity = 1) {
  const hold = (await commerce.reserve(user, { productId, quantity, version: 1 }, randomUUID())) as { id: string };
  const order = await payments.createPaymentOrder(user, hold.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return hold.id;
}

test('email 1: sign-in code — right recipient, a 6-digit code, the expiry; a provider failure is an error, not "code sent"', { skip }, async () => {
  const user = await emailUser('code');
  await auth.requestOtp(user.contact, '10.4.0.1');
  const [mail] = mailTo(user.contact);
  assert.equal(mail.subject, 'Your Samatat Sanskriti sign-in code');
  assert.match(mail.text, /^Your code is \d{6}\. It expires in 5 minutes\. Do not share it\.$/);
  assert.equal(fake.emails.length, 1, 'sent to nobody else');
  fake.failEmail = true;
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  await assert.rejects(auth.requestOtp(user.contact, '10.4.0.1'), /Email delivery is temporarily unavailable/);
});

test('email 2: checkout confirmation — reference, zone, quantity, amounts, IST time, QR link, receipt link, card instruction; nobody else’s data', { skip }, async () => {
  const user = await emailUser('cart');
  const other = await emailUser('other');
  const show = await makeShow({ price: 45000, title: 'Raktakarabi' });
  const co = await checkout.createCheckout(user, [{ productId: show.productId, quantity: 2, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  await tick();
  const bookingId = (await query<{ id: string }>('SELECT id FROM bookings WHERE checkout_id=$1', [co.id]))[0].id;
  const [mail] = mailTo(user.contact);
  assert.equal(fake.emails.length, 1);
  assert.equal(mail.subject, `Your Samatat Sanskriti tickets - ${co.reference}`);
  assert.equal(mail.idempotencyKey, `checkout:${co.id}`);
  for (const expected of [
    `Your booking is confirmed! View your QR tickets using the secure link below. ${CARDS}`,
    `Your QR tickets: ${BASE}/tickets/${bookingId}`,
    `Order ${co.reference} is confirmed.`,
    `Payment ${p.id}`, 'Zone: Premier', 'Raktakarabi', 'Quantity: 2 × ₹450 = ₹900', 'Total paid: ₹900',
    `Full receipt: ${BASE}/receipts/${co.id}`,
  ]) assert.ok(mail.text.includes(expected), `email mentions: ${expected}`);
  assert.match(mail.text, /\d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} [ap]m/i, 'performance time in IST, en-IN format');
  assert.ok(!mail.text.includes(other.contact));
  assert.ok(!/encrypted|token|secret/i.test(mail.text), 'no credential or token in the email');
});

test('email 3: single-booking confirmation — the booking’s own QR link and the card instruction, once', { skip }, async () => {
  const user = await emailUser('single');
  const show = await makeShow({ price: 30000 });
  const bookingId = await buySingle(user, show.productId, 3);
  await tick();
  await query("UPDATE jobs SET state='PENDING', run_at=now() WHERE kind='DELIVERY'"); // a lost DONE update
  await tick();
  const mails = mailTo(user.contact);
  assert.equal(mails.length, 1, 'a retried job is not a second email');
  const reference = (await query<{ reference: string }>('SELECT reference FROM bookings WHERE id=$1', [bookingId]))[0].reference;
  for (const expected of [CARDS, `Your QR tickets: ${BASE}/tickets/${bookingId}`, `Booking ${reference}`, 'Quantity: 3 × ₹300 = ₹900']) {
    assert.ok(mails[0].text.includes(expected), `email mentions: ${expected}`);
  }
  assert.equal(await (await query('SELECT count(*)::int n FROM tickets WHERE booking_id=$1', [bookingId]))[0].n, 3, 'no extra tickets');
});

test('email 4: "resend tickets" sends the same confirmation again to the verified email (and never by SMS while mobile is off)', { skip }, async () => {
  const user = await emailUser('resend');
  const show = await makeShow();
  const bookingId = await buySingle(user, show.productId);
  const { deliverBooking } = await import('../src/lib/tickets');
  await deliverBooking(bookingId);
  const [mail] = mailTo(user.contact);
  assert.ok(mail.text.includes(`${BASE}/tickets/${bookingId}`) && mail.text.includes(CARDS));
  assert.equal(fake.sms.length, 0);
  // A mobile-only account cannot be reached while mobile is off: a clear error, nothing sent.
  const mobileOnly = await withMobile(async () => {
    const u = await makeUser('customer', '+919876522004');
    return { u, bookingId: await buySingle(u, show.productId) };
  });
  await assert.rejects(deliverBooking(mobileOnly.bookingId), /SMS is not available/);
  assert.equal(fake.sms.length, 0);
});

test('email 5: show-cancellation notice — each affected email customer once, even when the job is retried; email failure only retries the notice', { skip }, async () => {
  const owner = await makeUser('owner');
  const show = await makeShow({ startsInMinutes: 60 });
  const paid = await emailUser('paid');
  const unrelated = await emailUser('unrelated');
  const paidBooking = await buySingle(paid, show.productId);
  await buySingle(unrelated, (await makeShow()).productId);
  await tick();
  fake.reset();
  fake.failEmail = true;
  await catalogue.updateShow(owner, show.showId, { status: 'CANCELLED', confirmCancellation: true });
  await tick();
  assert.equal((await query<{ status: string }>('SELECT status FROM bookings WHERE id=$1', [paidBooking]))[0].status, 'CANCELLED', 'the cancellation stands');
  const notice = (await query<{ state: string; last_error: string | null }>("SELECT state, last_error FROM jobs WHERE kind='NOTICE'"))[0];
  assert.equal(notice.state, 'PENDING');
  assert.match(String(notice.last_error), /Email delivery/);
  fake.failEmail = false;
  await query("UPDATE jobs SET run_at=now() WHERE kind='NOTICE'");
  await tick();
  // The send succeeded but its DONE update was lost: the retry must not email again.
  await query("UPDATE jobs SET state='PENDING', run_at=now() WHERE kind='NOTICE'");
  await tick();
  const mails = mailTo(paid.contact);
  const reference = (await query<{ reference: string }>('SELECT reference FROM bookings WHERE id=$1', [paidBooking]))[0].reference;
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, `Booking update ${reference}`);
  assert.match(mails[0].text, /cancelled\. Your tickets are void and a full refund has been started/);
  assert.equal(mails[0].idempotencyKey, `cancel-booking:${show.showId}:${paidBooking}`);
  assert.equal(mailTo(unrelated.contact).length, 0, 'customers of other shows are not notified');
});

test('tickets: unknown and malformed ticket/booking ids are refused safely', { skip }, async () => {
  const user = await emailUser('ids');
  const { ticketPass } = await import('../src/lib/tickets');
  await assert.rejects(ticketPass(user, randomUUID()), /Ticket not found/);
  assert.deepEqual(await commerce.ownedBookings(user.id, randomUUID()), []);
  await assert.rejects(commerce.ownedBookings(user.id, 'not-a-uuid')); // the page turns this into 404
  await assert.rejects(checkout.checkoutReceipt(user.id, randomUUID()));
});

/** Runs with mobile features on (to create a mobile-only purchase that already exists). */
async function withMobile<T>(run: () => Promise<T>): Promise<T> {
  const values = { MOBILE_PHONE_NUMBER_ENABLED: 'true', SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'test-auth-key', MSG91_OTP_TEMPLATE_ID: 'tmpl-otp', MSG91_TEMPLATE_ID: 'tmpl-confirm' };
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
