/**
 * MOBILE_PHONE_NUMBER_ENABLED (default false): the email-only production journey
 * with NO MSG91 settings at all, mobile sign-in/verification and every SMS refused
 * without calling any SMS gateway, parked SMS jobs, and the flag itself.
 * Real auth, checkout, payment, job, ticket and admission code on the local test
 * database; Razorpay, Resend and MSG91 are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv, webhook } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const CARDS = 'Please collect your physical cards before the show.';
const MSG91 = ['SMS_PROVIDER', 'MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID', 'MSG91_TEMPLATE_ID'];
let auth: typeof import('../src/lib/auth');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let jobs: typeof import('../src/lib/jobs');
let admission: typeof import('../src/lib/admission');
let env: typeof import('../src/lib/env');
let query: typeof import('../src/lib/db').query;
/** Every outgoing request to an SMS gateway (MSG91, httpSMS, generic webhook). */
let smsGatewayCalls: string[] = [];

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  // The production target: mobile off and MSG91 not configured at all; httpSMS keys present
  // to prove they are never used as a fallback.
  process.env.MOBILE_PHONE_NUMBER_ENABLED = 'false';
  for (const name of MSG91) delete process.env[name];
  Object.assign(process.env, { HTTPSMS_API_KEY: 'stub', HTTPSMS_FROM: '+919111222333', SMS_API_URL: 'https://sms.example.test/send', SMS_API_TOKEN: 'stub' });
  fake.install();
  const faked = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/msg91|httpsms|sms\.example/.test(url)) smsGatewayCalls.push(url);
    return faked(input, init);
  }) as typeof fetch;
  auth = await import('../src/lib/auth');
  checkout = await import('../src/lib/checkout');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  jobs = await import('../src/lib/jobs');
  admission = await import('../src/lib/admission');
  env = await import('../src/lib/env');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  for (const name of ['HTTPSMS_API_KEY', 'HTTPSMS_FROM', 'SMS_API_URL', 'SMS_API_TOKEN', 'MOBILE_PHONE_NUMBER_ENABLED']) delete process.env[name];
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  fake.reset();
  smsGatewayCalls = [];
  await resetDatabase();
});

function withEnv<T>(values: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  return Promise.resolve().then(run).finally(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
}
const count = async (sql: string, params: unknown[] = []) => (await query(sql, params))[0].n as number;
const emailsTo = (to: string) => fake.emails.filter((e) => e.to === to);
const emailCode = (to: string) => /code is (\d{6})/.exec(emailsTo(to).at(-1)!.text)![1];

async function buy(user: User, quantities: number[], startsInMinutes?: number) {
  const shows = [];
  while (shows.length < quantities.length) shows.push(await makeShow({ price: 40000, startsInMinutes }));
  const co = await checkout.createCheckout(user, shows.map((s, i) => ({ productId: s.productId, quantity: quantities[i], version: 1 })), randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const payment = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: payment.id, razorpay_signature: checkoutSignature(order.orderId, payment.id) }, user);
  return { co, shows, order, payment };
}
async function deliver() {
  await jobs.processJobs();
  await query("UPDATE jobs SET run_at=now() WHERE state='PENDING'");
  await jobs.processJobs();
}
const bookingsOf = async (checkoutId: string) =>
  (await query<{ id: string }>('SELECT id FROM bookings WHERE checkout_id=$1 ORDER BY created_at, id', [checkoutId])).map((r) => r.id);

// ---- FEATURE FLAG -----------------------------------------------------------------------------------

test('flag 1–4: missing = false, "false" = false, "true" only with complete MSG91 settings, malformed = false + reported', { skip }, async () => {
  await withEnv({ MOBILE_PHONE_NUMBER_ENABLED: undefined }, () => assert.equal(env.mobileFeaturesEnabled(), false));
  await withEnv({ MOBILE_PHONE_NUMBER_ENABLED: 'false' }, () => assert.equal(env.mobileFeaturesEnabled(), false));
  await withEnv({ MOBILE_PHONE_NUMBER_ENABLED: 'true' }, () => {
    assert.equal(env.mobileFeaturesEnabled(), false, 'switched on but MSG91 incomplete: stays off');
    assert.deepEqual(env.mobileConfigurationProblems(), ['SMS_PROVIDER=msg91', 'MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID', 'MSG91_TEMPLATE_ID']);
  });
  await withEnv({ MOBILE_PHONE_NUMBER_ENABLED: 'true', SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_OTP_TEMPLATE_ID: 'o', MSG91_TEMPLATE_ID: 't' },
    () => assert.equal(env.mobileFeaturesEnabled(), true));
  for (const bad of ['yes', '1', 'on', 'enabled', 'true1']) {
    await withEnv({ MOBILE_PHONE_NUMBER_ENABLED: bad, SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_OTP_TEMPLATE_ID: 'o', MSG91_TEMPLATE_ID: 't' }, () => {
      assert.equal(env.mobileFeaturesEnabled(), false, bad);
      assert.match(env.mobileConfigurationProblems()[0], /MOBILE_PHONE_NUMBER_ENABLED/);
    });
  }
  assert.deepEqual(env.configurationProblems(), [], 'email-only sales need no MSG91 setting');
});

test('flag 5: nothing in the request can switch mobile on (body, query, cookie)', { skip }, async () => {
  const { POST, GET } = await import('../app/api/auth/otp/request/route');
  assert.deepEqual(await GET().json(), { mobile: false });
  const res = await POST(new Request('https://staging.tickets.test/api/auth/otp/request?MOBILE_PHONE_NUMBER_ENABLED=true&mobile=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'MOBILE_PHONE_NUMBER_ENABLED=true', 'x-forwarded-for': '10.3.0.5' },
    body: JSON.stringify({ contact: '+919876511005', MOBILE_PHONE_NUMBER_ENABLED: 'true', mobileEnabled: true }),
  }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'MOBILE_DISABLED');
  assert.equal(process.env.MOBILE_PHONE_NUMBER_ENABLED, 'false');
  assert.deepEqual(smsGatewayCalls, []);
});

// ---- EMAIL AUTHENTICATION ---------------------------------------------------------------------------

test('email 6/7/12: email code request + verify work with no MSG91 config; an existing account is reused; logout and expiry end the session', { skip }, async () => {
  const existing = await makeUser('customer', 'reader@tickets.test', { mobile: null });
  const req = await auth.requestOtp('reader@tickets.test', '10.3.0.6');
  assert.equal('developmentCode' in req, false);
  const session = await auth.verifyOtp(req.challengeId, emailCode('reader@tickets.test'));
  assert.equal(session.user.id, existing.id);
  assert.equal((await auth.sessionUser(session.sessionToken))?.id, existing.id);
  await auth.revokeSession(session.sessionToken);
  assert.equal(await auth.sessionUser(session.sessionToken), null, 'logout');
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  const again = await auth.verifyOtp((await auth.requestOtp('reader@tickets.test', '10.3.0.6')).challengeId, emailCode('reader@tickets.test'));
  await query("UPDATE sessions SET expires_at=now()-interval '1 second'");
  assert.equal(await auth.sessionUser(again.sessionToken), null, 'expired session');
  assert.equal(await count('SELECT count(*)::int n FROM users'), 1, 'no duplicate account');
  assert.deepEqual(smsGatewayCalls, []);
});

test('email 8/9/10: expired, reused and wrong email codes are rejected without a session', { skip }, async () => {
  const req = await auth.requestOtp('codes@tickets.test', '10.3.0.8');
  const code = emailCode('codes@tickets.test');
  await assert.rejects(auth.verifyOtp(req.challengeId, code === '000000' ? '111111' : '000000'), /incorrect/i);
  await auth.verifyOtp(req.challengeId, code);
  await assert.rejects(auth.verifyOtp(req.challengeId, code), /expired|no longer valid/);
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  const late = await auth.requestOtp('codes@tickets.test', '10.3.0.8');
  await query("UPDATE otp_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [late.challengeId]);
  await assert.rejects(auth.verifyOtp(late.challengeId, emailCode('codes@tickets.test')), /expired|no longer valid/);
  assert.equal(await count('SELECT count(*)::int n FROM sessions'), 1);
});

test('email 11: email code requests stay rate-limited (30 s apart, 5 per hour)', { skip }, async () => {
  await auth.requestOtp('limit@tickets.test', '10.3.0.11');
  await assert.rejects(auth.requestOtp('limit@tickets.test', '10.3.0.11'), /30 seconds/);
  for (let i = 0; i < 3; i++) {
    await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
    await auth.requestOtp('limit@tickets.test', '10.3.0.11');
  }
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  await assert.rejects(auth.requestOtp('limit@tickets.test', '10.3.0.11'), /Too many attempts/);
  assert.equal(emailsTo('limit@tickets.test').length, 4);
});

// ---- MOBILE AUTHENTICATION (disabled) ---------------------------------------------------------------

test('mobile 13/14/15: mobile sign-in is refused the same way for known and unknown numbers; nothing stored, sent or signed in', { skip }, async () => {
  await makeUser('customer', '+919876511013');
  const known = await auth.requestOtp('+919876511013', '10.3.0.13').catch((e) => e);
  const unknown = await auth.requestOtp('98765 11099', '10.3.0.13').catch((e) => e);
  for (const error of [known, unknown]) {
    assert.equal(error.code, 'MOBILE_DISABLED');
    assert.equal(error.status, 400);
  }
  assert.equal(known.message, unknown.message, 'no account enumeration');
  assert.match(known.message, /email/);
  assert.equal(await count('SELECT count(*)::int n FROM otp_challenges'), 0);
  // A mobile code issued before the switch-off cannot sign anyone in.
  const { keyedHash } = await import('../src/lib/security');
  const old = (await query<{ id: string }>("INSERT INTO otp_challenges(contact,digest,expires_at) VALUES('+919876511013',$1,now()+interval '5 minutes') RETURNING id", [keyedHash('+919876511013:123456')]))[0];
  await assert.rejects(auth.verifyOtp(old.id, '123456'), /not available/);
  assert.equal(await count('SELECT count(*)::int n FROM sessions'), 0);
  // Adding a mobile to an email account is refused too.
  const { requestMobileVerification, verifyMobile } = await import('../src/lib/account-contacts');
  const emailUser = await makeUser('customer', 'add@tickets.test', { mobile: null });
  assert.equal((await requestMobileVerification(emailUser.id, '+919876511014', '10.3.0.13').catch((e) => e)).code, 'MOBILE_DISABLED');
  assert.equal((await verifyMobile(emailUser.id, old.id, '123456').catch((e) => e)).code, 'MOBILE_DISABLED');
  assert.equal((await query<{ verified_mobile: string | null }>('SELECT verified_mobile FROM users WHERE id=$1', [emailUser.id]))[0].verified_mobile, null);
  assert.deepEqual(smsGatewayCalls, [], 'no MSG91, httpSMS or webhook call');
});

test('mobile 18: switched on with SMS_PROVIDER=httpsms (keys present) → still no gateway call; email keeps working', { skip }, async () => {
  await withEnv({ MOBILE_PHONE_NUMBER_ENABLED: 'true', SMS_PROVIDER: 'httpsms' }, async () => {
    assert.equal((await auth.requestOtp('+919876511018', '10.3.0.18').catch((e) => e)).code, 'MOBILE_DISABLED');
    await auth.requestOtp('still@tickets.test', '10.3.0.18');
  });
  assert.deepEqual(smsGatewayCalls, []);
  assert.equal(emailsTo('still@tickets.test').length, 1);
});

// ---- CHECKOUT, PAYMENT, TICKETS, EMAIL --------------------------------------------------------------

test('journey 19–21/25/32/33/35/37: email-only customer buys with no MSG91 config; one email with the QR link + card instruction; owner-only access', { skip }, async () => {
  const user = await makeUser('customer', 'journey@tickets.test', { mobile: null });
  const stranger = await makeUser('customer', 'stranger@tickets.test', { mobile: null });
  const { co } = await buy(user, [2]);
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
  assert.equal(fake.emails.length, 0, 'nothing sent before the confirmation job');
  fake.failEmail = true;
  await deliver();
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED', 'email failure never undoes the booking');
  fake.failEmail = false;
  await query("UPDATE jobs SET run_at=now() WHERE state='PENDING'");
  await deliver();
  const [bookingId] = await bookingsOf(co.id);
  const mail = emailsTo(user.contact);
  assert.equal(mail.length, 1);
  assert.ok(mail[0].text.includes(`Your QR tickets: https://staging.tickets.test/tickets/${bookingId}`));
  assert.ok(mail[0].text.includes(CARDS));
  assert.ok(mail[0].text.includes(co.reference));
  const { ownedBookings } = await import('../src/lib/commerce');
  const mine = (await ownedBookings(user.id, bookingId)) as { tickets: { id: string }[] }[];
  assert.equal(mine[0].tickets.length, 2);
  assert.deepEqual(await ownedBookings(stranger.id, bookingId), []);
  const { ticketPass } = await import('../src/lib/tickets');
  await assert.rejects(ticketPass(stranger, mine[0].tickets[0].id), /Access denied/);
  assert.match((await ticketPass(user, mine[0].tickets[0].id)).qr, /^data:image\/png;base64,/);
  assert.equal(await count("SELECT count(*)::int n FROM jobs WHERE kind='NOTIFY'"), 0, 'no SMS job');
  assert.deepEqual(smsGatewayCalls, []);
});

test('journey 28/29/31/34/36: duplicate webhooks and email retries keep 2 bookings and the same QR credentials; the gate admits once', { skip }, async () => {
  const user = await makeUser('customer', 'multi@tickets.test', { mobile: null });
  const { co, payment, shows } = await buy(user, [1, 2], 30);
  const creds = async () => (await query<{ ticket_id: string; encrypted_token: string }>(
    "SELECT c.ticket_id, c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND c.status='ACTIVE' ORDER BY c.ticket_id", [co.id]));
  const first = await creds();
  await deliver();
  const hook = webhook('payment.captured', payment);
  await payments.ingestRazorpayWebhook(hook.body, hook.signature);
  await payments.ingestRazorpayWebhook(hook.body, hook.signature);
  await query("UPDATE jobs SET state='PENDING', run_at=now() WHERE kind='DELIVERY'");
  await deliver();
  assert.deepEqual(await creds(), first);
  assert.equal(first.length, 3);
  assert.equal(await count('SELECT count(*)::int n FROM bookings WHERE checkout_id=$1', [co.id]), 2);
  assert.equal(emailsTo(user.contact).length, 1);
  assert.ok(emailsTo(user.contact)[0].text.includes('Your QR tickets: https://staging.tickets.test/tickets\n'), 'two bookings → the ticket list');
  const { ownedBookings } = await import('../src/lib/commerce');
  assert.equal((await ownedBookings(user.id)).length, 2, 'the list shows every booking of the checkout');

  const scanner = await makeUser('scanner');
  await query(`INSERT INTO devices(id,name) VALUES('gate-one','Main') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO staff_scopes(user_id,show_id,gate,device_id) VALUES($1,$2,'gate-one','gate-one')`, [scanner.id, shows[0].showId]);
  const { decrypt } = await import('../src/lib/security');
  const token = decrypt((await query<{ encrypted_token: string }>(
    "SELECT c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND b.product_id=$2 AND c.status='ACTIVE'", [co.id, shows[0].productId]))[0].encrypted_token);
  const scan = () => admission.admit(scanner, { requestId: randomUUID(), ticketToken: token, showId: shows[0].showId, gateId: 'gate-one', deviceId: 'gate-one' });
  assert.equal((await scan()).result, 'ADMITTED');
  assert.equal((await scan()).result, 'DENIED');
});

test('journey 26/27: an unpaid order or a forged signature confirms nothing', { skip }, async () => {
  const user = await makeUser('customer', 'unpaid@tickets.test', { mobile: null });
  const show = await makeShow();
  const co = await checkout.createCheckout(user, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  await assert.rejects(payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: 'pay_forged', razorpay_signature: 'f'.repeat(64) }, user));
  assert.notEqual((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
  assert.equal(await count("SELECT count(*)::int n FROM bookings WHERE status='CONFIRMED'"), 0);
  await deliver();
  assert.equal(fake.emails.length, 0, 'nothing announced');
});

test('checkout 20–23: a mobile-only account (old session) cannot buy while mobile is off — refused before any hold or order', { skip }, async () => {
  const show = await makeShow();
  const mobileOnly = await makeUser('customer', '+919876511020');
  for (const attempt of [
    () => checkout.createCheckout(mobileOnly, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID()),
    () => commerce.reserve(mobileOnly, { productId: show.productId, quantity: 1, version: 1 }, randomUUID()),
  ]) {
    const error = await attempt().catch((e) => e);
    assert.equal(error.code, 'CONTACT_REQUIRED');
    assert.match(error.message, /verified email address is required/);
  }
  assert.equal(await count('SELECT count(*)::int n FROM bookings'), 0);
  assert.equal(await count('SELECT count(*)::int n FROM checkouts'), 0);
  assert.equal(await count('SELECT coalesce(sum(held),0)::int n FROM pools'), 0, 'no inventory held');
  assert.equal(fake.count('POST /orders'), 0);
});

// ---- SMS JOBS ---------------------------------------------------------------------------------------

test('sms 38/39/40/41: an account with email + verified mobile gets the email only; a queued SMS job is parked (no call, not delivered) and not resent when mobile is switched on', { skip }, async () => {
  const user = await makeUser('customer', 'both@tickets.test', { mobile: '+919876511038' });
  const { co } = await buy(user, [1]);
  // An SMS job queued while mobile was on, still pending when it was switched off.
  await query("INSERT INTO jobs(kind,key,payload) VALUES('NOTIFY',$1,$2)", [`sms:checkout:${co.id}`, JSON.stringify({ channel: 'sms', checkoutId: co.id })]);
  await deliver();
  assert.equal(emailsTo(user.contact).length, 1, 'the email is not blocked by the SMS');
  const sms = (await query<{ state: string; last_error: string; attempts: number }>("SELECT state, last_error, attempts FROM jobs WHERE kind='NOTIFY'"))[0];
  assert.deepEqual([sms.state, sms.last_error, sms.attempts], ['FAILED', jobs.SMS_DISABLED_MARKER, 1], 'parked after one try, no retries');
  assert.equal(await count("SELECT count(*)::int n FROM notification_deliveries WHERE channel='sms'"), 0, 'never recorded as delivered');
  assert.deepEqual(smsGatewayCalls, []);
  // Switching mobile on later does not resend the parked message by itself.
  await withEnv({ MOBILE_PHONE_NUMBER_ENABLED: 'true', SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'test-auth-key', MSG91_OTP_TEMPLATE_ID: 'tmpl-otp', MSG91_TEMPLATE_ID: 'tmpl-confirm' }, async () => {
    await deliver();
  });
  assert.equal(fake.sms.length, 0);
  assert.equal((await query<{ state: string }>("SELECT state FROM jobs WHERE kind='NOTIFY'"))[0].state, 'FAILED');
});

test('sms: a show-cancellation notice to a mobile-only account is parked, not retried, while mobile is off', { skip }, async () => {
  const user = await withEnv({ MOBILE_PHONE_NUMBER_ENABLED: 'true', SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'test-auth-key', MSG91_OTP_TEMPLATE_ID: 'tmpl-otp', MSG91_TEMPLATE_ID: 'tmpl-confirm' },
    async () => {
      const u = await makeUser('customer', '+919876511039');
      await buy(u, [1]);
      return u;
    });
  const bookingId = (await query<{ id: string }>('SELECT id FROM bookings WHERE user_id=$1', [user.id]))[0].id;
  await query("UPDATE jobs SET state='DONE' WHERE kind IN ('DELIVERY','NOTIFY')");
  await query("INSERT INTO jobs(kind,key,payload) VALUES('NOTICE','n1',$1)", [JSON.stringify({ bookingId, message: 'A performance you booked was cancelled.' })]);
  await jobs.processJobs();
  assert.equal((await query<{ state: string; last_error: string }>("SELECT state, last_error FROM jobs WHERE key='n1'"))[0].last_error, jobs.SMS_DISABLED_MARKER);
  assert.deepEqual(smsGatewayCalls, []);
});

// ---- SALES SAFETY AND STAFF -------------------------------------------------------------------------

test('sales 43/44: missing email delivery keeps customer sales closed even with ALLOW_PUBLIC_SALES=true', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser('customer', 'blocked@tickets.test', { mobile: null });
  assert.equal(process.env.ALLOW_PUBLIC_SALES, 'true');
  await withEnv({ RESEND_API_KEY: undefined }, async () => {
    for (const attempt of [
      () => checkout.createCheckout(user, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID()),
      () => commerce.reserve(user, { productId: show.productId, quantity: 1, version: 1 }, randomUUID()),
      () => auth.requestOtp(user.contact, '10.3.0.43'),
    ]) assert.equal((await attempt().catch((e) => e)).code, 'CONFIG_INVALID');
  });
  await withEnv({ ALLOW_PUBLIC_SALES: undefined }, async () => {
    await assert.rejects(checkout.createCheckout(user, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID()), 'the operator switch still applies');
  });
  assert.equal(await count('SELECT count(*)::int n FROM checkouts'), 0);
});

test('staff 45: owner and gate staff sign in by password with mobile off and no MSG91; roles enforced as before', { skip }, async () => {
  const { upsertStaff } = await import('../src/lib/staff');
  const password = 'staff password long enough';
  await upsertStaff({ contact: 'owner@tickets.test', role: 'owner', password });
  await upsertStaff({ contact: 'gate@tickets.test', role: 'scanner', password });
  assert.equal((await auth.loginStaff('owner@tickets.test', password, 'admin', '10.3.0.45')).user.role, 'owner');
  assert.equal((await auth.loginStaff('gate@tickets.test', password, 'gate', '10.3.0.45')).user.role, 'scanner');
  assert.equal((await auth.loginStaff('gate@tickets.test', password, 'admin', '10.3.0.45').catch((e) => e)).code, 'WRONG_PORTAL');
  assert.deepEqual(smsGatewayCalls, []);
});
