/**
 * The production target configuration: DEPLOY_ENV=production on a Clerk development
 * instance with the temporary CLERK_DEVELOPMENT_INSTANCE_ALLOWED override, mobile
 * features off and no MSG91 settings at all.
 *  - ALLOW_PUBLIC_SALES: "true" lets eligible purchases through; anything else refuses new
 *    holds AND new payment orders for earlier holds, creating nothing.
 *  - /api/health and the owner's ops status agree with the purchase gates.
 *  - CUSTOMER_OTP_ENABLED=true turns on EMAIL sign-in codes only: secure storage, expiry,
 *    attempt and rate limits, single use, provider failure; a mobile number is refused and
 *    no SMS is ever sent.
 * Real config, auth, checkout and payment code on the local test database; Razorpay and
 * Resend are the in-process fakes (no real external service is called).
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const MSG91 = ['SMS_PROVIDER', 'MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID', 'MSG91_TEMPLATE_ID'];
let auth: typeof import('../src/lib/auth');
let env: typeof import('../src/lib/env');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let ops: typeof import('../src/lib/ops');
let query: typeof import('../src/lib/db').query;
let gatewayCalls: string[] = [];

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  Object.assign(process.env, {
    DEPLOY_ENV: 'production',
    RAZORPAY_KEY_ID: 'rzp_live_integration',
    CLERK_DEVELOPMENT_INSTANCE_ALLOWED: 'true', // development Clerk keys from the fixtures
    MOBILE_PHONE_NUMBER_ENABLED: 'false',
    CUSTOMER_OTP_ENABLED: 'true',
  });
  for (const name of MSG91) delete process.env[name];
  fake.install();
  const faked = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/msg91|httpsms|sms/i.test(url)) gatewayCalls.push(url);
    return faked(input, init);
  }) as typeof fetch;
  auth = await import('../src/lib/auth');
  env = await import('../src/lib/env');
  checkout = await import('../src/lib/checkout');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  ops = await import('../src/lib/ops');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  useLiveStagingEnv();
  delete process.env.CLERK_DEVELOPMENT_INSTANCE_ALLOWED;
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  fake.reset();
  gatewayCalls = [];
  process.env.ALLOW_PUBLIC_SALES = 'true';
  process.env.CUSTOMER_OTP_ENABLED = 'true';
  await resetDatabase();
});

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);
const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });
const codeFor = (to: string) => /code is (\d{6})/.exec(fake.emails.filter((e) => e.to === to).at(-1)!.text)![1];
async function nothingCreated() {
  assert.equal(await count('SELECT count(*)::int n FROM bookings'), 0, 'no booking');
  assert.equal(await count('SELECT count(*)::int n FROM checkouts'), 0, 'no checkout');
  assert.equal(await count('SELECT count(*)::int n FROM payment_attempts'), 0, 'no payment attempt');
  assert.equal(fake.count('POST /orders'), 0, 'no Razorpay order');
}
async function pay(user: User, checkoutId: string) {
  const order = await checkout.createCheckoutPaymentOrder(user, checkoutId);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
}

// ---- CONFIGURATION AND THE PUBLIC-SALES SWITCH -------------------------------------------------------

test('production + Clerk development override + valid settings: configuration passes and an eligible purchase completes', { skip }, async () => {
  assert.deepEqual(env.configurationProblems(), []);
  const show = await makeShow();
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(show, 2)], randomUUID());
  await pay(buyer, co.id);
  assert.equal((await checkout.checkoutReceipt(buyer.id, co.id)).status, 'CONFIRMED');
  assert.equal(await count("SELECT count(*)::int n FROM tickets WHERE status='ACTIVE'"), 2);
});

test('ALLOW_PUBLIC_SALES not "true": new holds and checkouts are refused and nothing is created', { skip }, async () => {
  const show = await makeShow();
  const buyer = await makeUser();
  for (const value of ['false', '', 'TRUE', 'yes']) {
    process.env.ALLOW_PUBLIC_SALES = value;
    await assert.rejects(checkout.createCheckout(buyer, [line(show)], randomUUID()), /Ticket sales are paused/, value);
    await assert.rejects(commerce.reserve(buyer, line(show), randomUUID()), /Ticket sales are paused/, value);
  }
  await nothingCreated();
});

test('ALLOW_PUBLIC_SALES switched off after a hold: no new payment order (cart and single); a payment already made is honoured', { skip }, async () => {
  const show = await makeShow();
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(show)], randomUUID());
  const single = await commerce.reserve(await makeUser(), line(show), randomUUID());
  const payer = await makeUser();
  const open = await checkout.createCheckout(payer, [line(show)], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(payer, open.id); // Razorpay window already open
  const ordersBefore = fake.count('POST /orders');
  process.env.ALLOW_PUBLIC_SALES = 'false';
  await assert.rejects(checkout.createCheckoutPaymentOrder(buyer, co.id), /Ticket sales are paused/);
  const singleOwner = (await query<User>('SELECT u.* FROM users u JOIN bookings b ON b.user_id=u.id WHERE b.id=$1', [single.id]))[0];
  await assert.rejects(payments.createPaymentOrder(singleOwner, single.id), /Ticket sales are paused/);
  assert.equal(fake.count('POST /orders'), ordersBefore, 'no new Razorpay order');
  // The customer whose window was open pays: verified, honoured (existing policy), not refunded.
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, payer);
  assert.equal((await checkout.checkoutReceipt(payer.id, open.id)).status, 'CONFIRMED');
  // A forged signature still issues nothing.
  const other = await makeUser();
  process.env.ALLOW_PUBLIC_SALES = 'true';
  const forgedCo = await checkout.createCheckout(other, [line(show)], randomUUID());
  const forgedOrder = await checkout.createCheckoutPaymentOrder(other, forgedCo.id);
  const fp = fake.pay(forgedOrder.orderId);
  await assert.rejects(payments.verifyRazorpayCallback({ razorpay_order_id: forgedOrder.orderId, razorpay_payment_id: fp.id, razorpay_signature: 'f'.repeat(64) }, other));
  assert.equal(await count("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1", [forgedCo.id]), 0);
});

test('health and the owner ops status agree with the gates; problem names only, never values', { skip }, async () => {
  const { GET } = await import('../app/api/health/route');
  const read = async () => (await GET()).json();
  let body = await read();
  assert.equal(body.config, true);
  assert.equal(body.publicSales, true);
  process.env.ALLOW_PUBLIC_SALES = 'false';
  body = await read();
  assert.deepEqual([body.config, body.publicSales, body.staff], [true, false, true]);
  let status = await ops.opsStatus();
  assert.equal(status.configuration.publicSales, false);
  assert.ok(status.warnings.some((w) => /paused by the operator/.test(w)));
  // Strict Clerk rule (override off) with development keys: config false, the reason named.
  process.env.ALLOW_PUBLIC_SALES = 'true';
  delete process.env.CLERK_DEVELOPMENT_INSTANCE_ALLOWED;
  try {
    body = await read();
    assert.deepEqual([body.config, body.publicSales, body.staff], [false, false, true]);
    status = await ops.opsStatus();
    assert.ok(status.configuration.salesProblems.some((p) => p.startsWith('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')));
    assert.ok(!JSON.stringify(status).includes(process.env.CLERK_SECRET_KEY!), 'no secret value');
    assert.ok(!JSON.stringify(status).includes(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!), 'no key value');
    const buyer = await makeUser();
    await assert.rejects(checkout.createCheckout(buyer, [line(await makeShow())], randomUUID()), /not configured for sales/);
  } finally {
    process.env.CLERK_DEVELOPMENT_INSTANCE_ALLOWED = 'true';
  }
});

test('the Clerk override changes no session check: unknown tokens and unverified Clerk emails sign nobody in', { skip }, async () => {
  assert.equal(await auth.sessionUser('not-a-real-session-token'), null);
  assert.equal(auth.verifiedClerkEmail({ primaryEmailAddress: { emailAddress: 'x@tickets.test', verification: { status: 'unverified' } }, emailAddresses: [{ emailAddress: 'x@tickets.test', verification: { status: 'unverified' } }] }), null);
  const staffUser = await makeUser('owner', 'owner-google@tickets.test');
  const viaGoogle = await auth.ensureUserFromClerk('user_dev_instance', 'owner-google@tickets.test');
  assert.deepEqual([viaGoogle.id, viaGoogle.role], [staffUser.id, 'customer'], 'Google still never grants staff powers');
});

// ---- EMAIL-ONLY SIGN-IN CODES -------------------------------------------------------------------------

test('email OTP on: a code is stored hashed, emailed, signs in once, and the session is real', { skip }, async () => {
  const customer = await makeUser('customer', 'otp@tickets.test', { mobile: null });
  const { challengeId } = await auth.requestOtp('otp@tickets.test', '10.20.0.1');
  const code = codeFor('otp@tickets.test');
  const stored = (await query<{ digest: string }>('SELECT digest FROM otp_challenges WHERE id=$1', [challengeId]))[0];
  assert.ok(!stored.digest.includes(code), 'only a keyed hash is stored');
  const session = await auth.verifyOtp(challengeId, code);
  assert.equal(session.user.id, customer.id);
  assert.equal((await auth.sessionUser(session.sessionToken!))?.id, customer.id);
  await assert.rejects(auth.verifyOtp(challengeId, code), /expired or is no longer valid/, 'single use');
  assert.equal(gatewayCalls.length, 0);
});

test('email OTP on: wrong codes, 5-attempt limit, expiry and a superseded code never sign in', { skip }, async () => {
  await makeUser('customer', 'limits@tickets.test', { mobile: null });
  const first = await auth.requestOtp('limits@tickets.test', '10.20.0.2');
  const firstCode = codeFor('limits@tickets.test');
  for (let i = 0; i < 5; i++) await assert.rejects(auth.verifyOtp(first.challengeId, '000000'), /incorrect|expired/);
  await assert.rejects(auth.verifyOtp(first.challengeId, firstCode), /expired or is no longer valid/, 'locked after 5 attempts');
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  const second = await auth.requestOtp('limits@tickets.test', '10.20.0.2');
  const secondCode = codeFor('limits@tickets.test');
  await query("UPDATE otp_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [second.challengeId]);
  await assert.rejects(auth.verifyOtp(second.challengeId, secondCode), /expired/, 'expired');
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  const third = await auth.requestOtp('limits@tickets.test', '10.20.0.2');
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  await auth.requestOtp('limits@tickets.test', '10.20.0.2');
  await assert.rejects(auth.verifyOtp(third.challengeId, codeFor('limits@tickets.test')), /expired or is no longer valid/, 'a newer code supersedes the older one');
});

test('email OTP on: 30-second spacing and 5 codes per address per hour; provider failure is an error, not "sent"', { skip }, async () => {
  await auth.requestOtp('rate@tickets.test', '10.20.0.3');
  await assert.rejects(auth.requestOtp('rate@tickets.test', '10.20.0.3'), /wait 30 seconds/);
  // Every request counts toward the 5 per hour, the refused one above included (existing rule).
  for (let i = 0; i < 3; i++) {
    await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
    await auth.requestOtp('rate@tickets.test', '10.20.0.3');
  }
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  await assert.rejects(auth.requestOtp('rate@tickets.test', '10.20.0.3'), /Too many attempts/);
  fake.failEmail = true;
  await assert.rejects(auth.requestOtp('down@tickets.test', '10.20.0.4'), /Email delivery is temporarily unavailable/);
});

test('email OTP on does NOT enable phone sign-in: a mobile number is refused, nothing stored, no SMS; GET reports email only', { skip }, async () => {
  const { GET } = await import('../app/api/auth/otp/request/route');
  assert.deepEqual(await GET().json(), { codeSignIn: true, mobile: false });
  await assert.rejects(auth.requestOtp('+919876512345', '10.20.0.5'), /mobile number is not available/);
  const pre = (await query<{ id: string }>(
    "INSERT INTO otp_challenges(contact,digest,expires_at) VALUES('+919876512345','x',now()+interval '5 minutes') RETURNING id"))[0];
  await assert.rejects(auth.verifyOtp(pre.id, '123456'), /mobile number is not available/);
  assert.equal(await count("SELECT count(*)::int n FROM otp_challenges WHERE contact LIKE '+%' AND digest<>'x'"), 0);
  assert.equal(await count('SELECT count(*)::int n FROM sessions'), 0);
  assert.deepEqual(gatewayCalls, [], 'no SMS gateway called');
  assert.equal(fake.sms.length, 0);
  assert.deepEqual(env.mobileConfigurationProblems(), [], 'MSG91 settings are not required while mobile is off');
});

test('email OTP off: email and mobile codes both refused; no email or SMS', { skip }, async () => {
  process.env.CUSTOMER_OTP_ENABLED = 'false';
  await assert.rejects(auth.requestOtp('off@tickets.test', '10.20.0.6'), /not available at the moment/);
  await assert.rejects(auth.requestOtp('+919876512346', '10.20.0.6'), /not available at the moment/);
  assert.equal(fake.emails.length, 0);
  assert.deepEqual(gatewayCalls, []);
});
