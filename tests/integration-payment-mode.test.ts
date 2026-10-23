/**
 * Razorpay TEST and LIVE modes on one production deployment (DEPLOY_ENV=production).
 * Root causes fixed: production refused any Razorpay test key ("production needs a live key"),
 * and any sales-configuration problem refused every customer API, so a payment setting also
 * blocked email sign-in codes and made the catalogue show every ticket closed (labelled
 * "Sold out" on the seat map).
 *  - Configuration: test and live keys both valid in production; RAZORPAY_MODE is an interlock;
 *    invalid payment settings keep sales closed but never stop sign-in codes.
 *  - Each payment order records its mode (migration 0011); a later key switch never reinterprets
 *    it: the ledger keeps test money out of income, test tickets are refused at the gate once
 *    live, refunds and reconciliation never cross environments.
 *  - Email sign-in codes work in both modes; availability: sellable, sold out, closed, unavailable.
 * Real code on the local test database; Razorpay and Resend are the in-process fakes (no real
 * payment, refund or email).
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv as liveStagingEnv } from './helpers/fixtures';
import { zoneStatus } from '../src/lib/zone-status';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let env: typeof import('../src/lib/env');
let gate: typeof import('../src/lib/config-gate');
let auth: typeof import('../src/lib/auth');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let refunds: typeof import('../src/lib/refunds');
let admission: typeof import('../src/lib/admission');
let catalogue: typeof import('../src/lib/catalogue');
let ledger: typeof import('../src/lib/attempts');
let jobs: typeof import('../src/lib/jobs');
let query: typeof import('../src/lib/db').query;

/** The deployment under test: production, Clerk development keys allowed, Razorpay mode from the key. */
function productionEnv() {
  liveStagingEnv();
  Object.assign(process.env, { DEPLOY_ENV: 'production', CLERK_DEVELOPMENT_INSTANCE_ALLOWED: 'true', TICKET_COPY_EMAIL: 'off' });
  delete process.env.RAZORPAY_MODE;
}
/** Switching modes = replacing the key id (and secrets) in the Worker settings; here only the id changes. */
const setRazorpayKeys = (mode: 'test' | 'live') => { process.env.RAZORPAY_KEY_ID = `rzp_${mode}_integration`; };

before(async () => {
  if (skip) return;
  productionEnv();
  fake.install();
  env = await import('../src/lib/env');
  gate = await import('../src/lib/config-gate');
  auth = await import('../src/lib/auth');
  checkout = await import('../src/lib/checkout');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  refunds = await import('../src/lib/refunds');
  admission = await import('../src/lib/admission');
  catalogue = await import('../src/lib/catalogue');
  ledger = await import('../src/lib/attempts');
  jobs = await import('../src/lib/jobs');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  liveStagingEnv();
  delete process.env.CLERK_DEVELOPMENT_INSTANCE_ALLOWED;
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  productionEnv();
  setRazorpayKeys('test');
  fake.reset();
  await resetDatabase();
});

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);
const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });
async function buy(user: User, show: { productId: string }, quantity = 1) {
  const co = await checkout.createCheckout(user, [line(show, quantity)], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return { co, orderId: order.orderId, paymentId: p.id };
}
const recordedMode = async (orderId: string) => (await query<{ m: string | null }>('SELECT provider_mode m FROM payment_attempts WHERE provider_order_id=$1', [orderId]))[0]?.m;

// ---- CONFIGURATION -------------------------------------------------------------------------------------

test('production accepts Razorpay test keys and live keys; the mode comes from trusted server settings', { skip }, () => {
  setRazorpayKeys('test');
  assert.deepEqual(env.configurationProblems(), [], 'the reported production state (test key) is valid');
  assert.equal(env.paymentMode(), 'test');
  setRazorpayKeys('live');
  assert.deepEqual(env.configurationProblems(), []);
  assert.equal(env.paymentMode(), 'live');
});

test('RAZORPAY_MODE is an interlock: a key from the other environment is refused; junk values are refused', { skip }, () => {
  process.env.RAZORPAY_MODE = 'live'; setRazorpayKeys('test');
  assert.ok(env.paymentConfigurationProblems().some((p) => /RAZORPAY_MODE=live needs an rzp_live_ key/.test(p)));
  process.env.RAZORPAY_MODE = 'test'; setRazorpayKeys('live');
  assert.ok(env.paymentConfigurationProblems().some((p) => /RAZORPAY_MODE=test needs an rzp_test_ key/.test(p)));
  process.env.RAZORPAY_MODE = 'LIVE'; setRazorpayKeys('live');
  assert.deepEqual(env.paymentConfigurationProblems(), [], 'case-insensitive');
  process.env.RAZORPAY_MODE = 'sandbox';
  assert.ok(env.paymentConfigurationProblems().some((p) => p.startsWith('RAZORPAY_MODE')));
  delete process.env.RAZORPAY_MODE;
  process.env.RAZORPAY_KEY_ID = 'not-a-razorpay-key';
  assert.ok(env.paymentConfigurationProblems().some((p) => /a Razorpay key id/.test(p)));
  process.env.DEPLOY_ENV = 'staging'; setRazorpayKeys('live');
  assert.ok(env.paymentConfigurationProblems().some((p) => /staging needs a test key/.test(p)), 'staging never takes real money');
});

test('invalid payment settings close sales (shown as closed, never sold out) but never stop sign-in codes', { skip }, async () => {
  const show = await makeShow();
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  delete process.env.RAZORPAY_KEY_SECRET;
  assert.equal(env.customerPurchasesOpen(), false);
  assert.equal((await catalogue.publicProducts(festival.id)).find((p) => p.id === show.productId)?.state, 'CLOSED');
  for (const path of ['/api/holds', '/api/checkouts', '/api/payments/order']) assert.match(String(gate.apiRefusal(path)), /not open/, path);
  for (const path of ['/api/auth/otp/request', '/api/auth/otp/verify', '/api/auth/me', '/api/cart', '/api/bookings', '/api/checkouts/abc']) assert.equal(gate.apiRefusal(path), null, path);
  const buyer = await makeUser();
  await assert.rejects(checkout.createCheckout(buyer, [line(show)], randomUUID()), /not configured for sales/);
  const otp = await auth.requestOtp('someone@tickets.test', '10.50.0.1');
  assert.ok(otp.challengeId, 'sign-in code still sent');
  assert.equal(await count('SELECT count(*)::int n FROM bookings'), 0);
  assert.equal(fake.count('POST /orders'), 0);
});

// ---- EMAIL SIGN-IN CODES IN BOTH MODES -------------------------------------------------------------------

test('email sign-in code: request and verify in test mode and in live mode; a broken email provider refuses safely', { skip }, async () => {
  for (const mode of ['test', 'live'] as const) {
    setRazorpayKeys(mode);
    const mail = `${mode}-user@tickets.test`;
    const { challengeId } = await auth.requestOtp(mail, '10.50.0.2');
    const code = /code is (\d{6})/.exec(fake.emails.filter((e) => e.to === mail).at(-1)!.text)![1];
    const session = await auth.verifyOtp(challengeId, code);
    assert.equal((await auth.sessionUser(session.sessionToken!))?.contact, mail, mode);
    await assert.rejects(auth.verifyOtp(challengeId, code), /expired or is no longer valid/, `${mode}: single use`);
  }
  delete process.env.RESEND_API_KEY;
  const before = await count('SELECT count(*)::int n FROM otp_challenges');
  await assert.rejects(auth.requestOtp('nomail@tickets.test', '10.50.0.3'), (e: unknown) => (e as { code?: string }).code === 'CONFIG_INVALID');
  assert.equal(await count('SELECT count(*)::int n FROM otp_challenges'), before, 'nothing stored');
});

// ---- PAYMENT LIFECYCLE IN BOTH MODES --------------------------------------------------------------------

test('test-mode lifecycle: order recorded as test, payment confirms, tickets issued, email marked [TEST], not counted as income', { skip }, async () => {
  const show = await makeShow();
  const buyer = await makeUser();
  const { co, orderId } = await buy(buyer, show, 2);
  assert.equal(await recordedMode(orderId), 'test');
  assert.equal((await checkout.checkoutReceipt(buyer.id, co.id)).status, 'CONFIRMED');
  assert.equal(await count("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND t.status='ACTIVE'", [co.id]), 2);
  await jobs.processJobs();
  const mail = fake.emails.find((e) => e.to === buyer.contact)!;
  assert.match(mail.subject, /^\[TEST\] /);
  assert.match(mail.text, /^TEST BOOKING/);
  assert.match(mail.html!, /TEST BOOKING/);
  const money = await ledger.accountsLedger();
  assert.equal(money.income, 0, 'test money is not income');
  assert.equal(money.testIncome, Number((await query<{ total: number }>('SELECT total FROM checkouts WHERE id=$1', [co.id]))[0].total));
  assert.equal((money.payments as { mode: string }[])[0].mode, 'test');
});

test('live-mode lifecycle (mocked provider): order recorded as live, payment confirms, income counted, no [TEST] marking', { skip }, async () => {
  setRazorpayKeys('live');
  const show = await makeShow();
  const buyer = await makeUser();
  const { co, orderId } = await buy(buyer, show, 1);
  assert.equal(await recordedMode(orderId), 'live');
  assert.equal((await checkout.checkoutReceipt(buyer.id, co.id)).status, 'CONFIRMED');
  await jobs.processJobs();
  assert.ok(!/\[TEST\]/.test(fake.emails.find((e) => e.to === buyer.contact)!.subject));
  const money = await ledger.accountsLedger();
  assert.equal(money.testIncome, 0);
  assert.ok(money.income > 0);
});

test('switching keys never reinterprets a payment: test tickets are refused at the gate once live, admitted while testing', { skip }, async () => {
  const show = await makeShow({ startsInMinutes: 30 });
  const buyer = await makeUser();
  const { co, orderId } = await buy(buyer, show, 2);
  const scanner = await makeUser('scanner');
  await query(`INSERT INTO devices(id,name) VALUES('gate-one','Main') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO staff_scopes(user_id,show_id,gate,device_id) VALUES($1,$2,'gate-one','gate-one')`, [scanner.id, show.showId]);
  const { decrypt } = await import('../src/lib/security');
  const tokens = (await query<{ encrypted_token: string }>(
    "SELECT c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND c.status='ACTIVE' ORDER BY t.ordinal", [co.id]))
    .map((r) => decrypt(r.encrypted_token));
  const scan = (token: string) => admission.admit(scanner, { requestId: randomUUID(), ticketToken: token, showId: show.showId, gateId: 'gate-one', deviceId: 'gate-one' });
  setRazorpayKeys('live');
  assert.equal(await recordedMode(orderId), 'test', 'the recorded mode does not change with the keys');
  const denied = await scan(tokens[0]);
  assert.equal(denied.result, 'DENIED');
  assert.match(String(denied.reason), /Test ticket/);
  assert.equal(await count("SELECT count(*)::int n FROM scan_requests WHERE code='TEST_PAYMENT'"), 1);
  assert.equal((await ledger.accountsLedger()).income, 0, 'still not income after going live');
  setRazorpayKeys('test');
  assert.equal((await scan(tokens[1])).result, 'ADMITTED', 'while testing, the gate admits test tickets');
});

test('refunds never cross environments: a test payment is not refunded with live keys (stays REQUESTED, case opened); same mode refunds normally', { skip }, async () => {
  const show = await makeShow();
  const buyer = await makeUser();
  const { co } = await buy(buyer, show, 1);
  const pay = (await query<{ id: string; booking_id: string | null }>('SELECT id, booking_id FROM payments WHERE checkout_id=$1', [co.id]))[0];
  const booking = (await query<{ id: string }>('SELECT id FROM bookings WHERE checkout_id=$1', [co.id]))[0];
  const refund = (await query<{ id: string }>("INSERT INTO refunds(booking_id,payment_id,amount,reason) VALUES($1,$2,100,'test') RETURNING id", [booking.id, pay.id]))[0];
  setRazorpayKeys('live');
  assert.equal(await refunds.executeRefund(refund.id), 'REQUESTED');
  assert.equal(fake.calls.filter((c) => /refund/.test(c)).length, 0, 'no provider call with the wrong keys');
  assert.equal(await count("SELECT count(*)::int n FROM reconciliation_cases WHERE key=$1", ['refund-mode:' + refund.id]), 1);
  assert.equal((await query<{ state: string }>('SELECT state FROM refunds WHERE id=$1', [refund.id]))[0].state, 'REQUESTED', 'never marked done');
  setRazorpayKeys('test');
  const state = await refunds.executeRefund(refund.id);
  assert.ok(['PROCESSING', 'SUCCEEDED'].includes(state), state);
  assert.ok(fake.calls.some((c) => /refund/.test(c)), 'refunded with the matching keys');
});

test('reconciliation only checks orders of the current environment', { skip }, async () => {
  const show = await makeShow();
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(show)], randomUUID());
  await checkout.createCheckoutPaymentOrder(buyer, co.id); // test-mode order, not paid
  await query("UPDATE payment_attempts SET next_reconcile_at=now()-interval '1 minute'");
  setRazorpayKeys('live');
  const before = fake.calls.length;
  assert.equal((await payments.reconcileOpenRazorpayPayments(10)).checked, 0);
  assert.equal(fake.calls.length, before, 'no Razorpay call with the other environment\'s keys');
  setRazorpayKeys('test');
  await query("UPDATE payment_attempts SET next_reconcile_at=now()-interval '1 minute'");
  assert.equal((await payments.reconcileOpenRazorpayPayments(10)).checked, 1);
});

test('legacy payment (mode not recorded, before 0011) whose environment does not know it is never marked refunded or failed', { skip }, async () => {
  const show = await makeShow();
  const buyer = await makeUser();
  const { co, orderId, paymentId } = await buy(buyer, show, 1);
  await query('UPDATE payment_attempts SET provider_mode=NULL WHERE provider_order_id=$1', [orderId]);
  assert.equal(await recordedMode(orderId), null, 'unknown stays unknown: nothing guesses test or live');
  const pay = (await query<{ id: string }>('SELECT id FROM payments WHERE checkout_id=$1', [co.id]))[0];
  const booking = (await query<{ id: string }>('SELECT id FROM bookings WHERE checkout_id=$1', [co.id]))[0];
  const refund = (await query<{ id: string }>("INSERT INTO refunds(booking_id,payment_id,amount,reason) VALUES($1,$2,100,'test') RETURNING id", [booking.id, pay.id]))[0];
  // The current keys belong to the other Razorpay environment: it has never heard of this payment.
  fake.payments.delete(paymentId);
  await assert.rejects(refunds.executeRefund(refund.id));
  assert.equal((await query<{ state: string }>('SELECT state FROM refunds WHERE id=$1', [refund.id]))[0].state, 'REQUESTED', 'left for retry or an operator; never done, never failed');
  assert.equal([...fake.refunds.values()].length, 0, 'no refund created anywhere');
});

// ---- AVAILABILITY -----------------------------------------------------------------------------------------

test('availability: sellable with a valid test-mode configuration; genuine sold out; expired holds return the seats', { skip }, async () => {
  const show = await makeShow({ allocation: 1 });
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  const state = async () => (await catalogue.publicProducts(festival.id)).find((p) => p.id === show.productId);
  assert.deepEqual([(await state())?.state, (await state())?.available], ['SELLABLE', 1], 'the reported production state no longer closes everything');
  const hold = await commerce.reserve(await makeUser(), line(show), randomUUID());
  assert.deepEqual([(await state())?.state, (await state())?.available], ['SOLD_OUT', 0], 'a held seat counts');
  await query("UPDATE bookings SET expires_at=now()-interval '1 minute' WHERE id=$1", [hold.id]);
  await commerce.expireHolds();
  assert.deepEqual([(await state())?.state, (await state())?.available], ['SELLABLE', 1], 'an expired hold frees the seat');
});

test('seat map status: sold out, closed and unavailable are distinct; only available can be chosen', () => {
  assert.equal(zoneStatus({ productId: 'p', available: 3 }), 'AVAILABLE');
  assert.equal(zoneStatus({ productId: 'p', available: 0 }), 'SOLD_OUT');
  assert.equal(zoneStatus({ productId: 'p', available: 0, closed: true }), 'CLOSED', 'closed sales are not "sold out"');
  assert.equal(zoneStatus({ productId: 'p', available: 5, closed: true }), 'CLOSED');
  assert.equal(zoneStatus({ productId: null, available: 0 }), 'UNAVAILABLE');
});
