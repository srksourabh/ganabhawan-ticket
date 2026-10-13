/**
 * CUSTOMER_OTP_ENABLED unset (the default; customer code sign-in temporarily off):
 * the request and verify APIs refuse before storing, sending or signing in anything,
 * nothing in a request can switch it on, and Google (Clerk) sign-in, account linking,
 * booking history, staff passwords and role checks keep working. Adding a mobile to an
 * account is not sign-in and is unaffected. Real auth, staff, checkout and payment code on
 * the local test database; Razorpay/Resend/MSG91 are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const PASSWORD = 'staff password long enough';
const OFF = /one-time code is not available at the moment/;
let auth: typeof import('../src/lib/auth');
let env: typeof import('../src/lib/env');
let staff: typeof import('../src/lib/staff');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let contacts: typeof import('../src/lib/account-contacts');
let security: typeof import('../src/lib/security');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  delete process.env.CUSTOMER_OTP_ENABLED; // the production default
  fake.install();
  auth = await import('../src/lib/auth');
  env = await import('../src/lib/env');
  staff = await import('../src/lib/staff');
  checkout = await import('../src/lib/checkout');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  contacts = await import('../src/lib/account-contacts');
  security = await import('../src/lib/security');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  process.env.CUSTOMER_OTP_ENABLED = 'true';
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  fake.reset();
  await resetDatabase();
});

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);

test('the switch: only an explicit "true" turns customer code sign-in on', () => {
  const saved = process.env.CUSTOMER_OTP_ENABLED;
  try {
    for (const value of [undefined, '', 'false', '1', 'yes', 'on', 'true!']) {
      if (value === undefined) delete process.env.CUSTOMER_OTP_ENABLED; else process.env.CUSTOMER_OTP_ENABLED = value;
      assert.equal(env.customerOtpEnabled(), false, String(value));
    }
    for (const value of ['true', 'TRUE', ' true ']) {
      process.env.CUSTOMER_OTP_ENABLED = value;
      assert.equal(env.customerOtpEnabled(), true, value);
    }
  } finally {
    if (saved === undefined) delete process.env.CUSTOMER_OTP_ENABLED; else process.env.CUSTOMER_OTP_ENABLED = saved;
  }
});

test('off: a code request stores nothing, sends nothing and counts nothing', { skip }, async () => {
  await makeUser('customer', 'fan@tickets.test', { mobile: null });
  await assert.rejects(auth.requestOtp('fan@tickets.test', '10.9.0.1'),
    (e: unknown) => e instanceof Error && OFF.test(e.message) && (e as { status?: number }).status === 403 && (e as { code?: string }).code === 'OTP_DISABLED');
  await assert.rejects(auth.requestOtp('+919876500001', '10.9.0.1'), OFF, 'mobile sign-in codes too');
  assert.equal(await count('SELECT count(*)::int n FROM otp_challenges'), 0);
  assert.equal(await count('SELECT count(*)::int n FROM rate_limits'), 0);
  assert.equal(fake.emails.length, 0);
  assert.equal(fake.sms.length, 0);
});

test('off: the APIs refuse direct calls; nothing in the request switches it on; no session cookie', { skip }, async () => {
  const request = await import('../app/api/auth/otp/request/route');
  const verify = await import('../app/api/auth/otp/verify/route');
  assert.deepEqual(await request.GET().json(), { codeSignIn: false, mobile: true });
  const res = await request.POST(new Request('https://staging.tickets.test/api/auth/otp/request?CUSTOMER_OTP_ENABLED=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'CUSTOMER_OTP_ENABLED=true', 'x-forwarded-for': '10.9.0.2' },
    body: JSON.stringify({ contact: 'direct@tickets.test', CUSTOMER_OTP_ENABLED: 'true', codeSignIn: true }),
  }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: auth.OTP_SIGN_IN_UNAVAILABLE, code: 'OTP_DISABLED' });
  assert.equal(process.env.CUSTOMER_OTP_ENABLED, undefined);
  const v = await verify.POST(new Request('https://staging.tickets.test/api/auth/otp/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: randomUUID(), code: '123456' }),
  }));
  assert.equal(v.status, 403);
  assert.equal(v.headers.get('set-cookie'), null);
  assert.equal(fake.emails.length, 0);
});

test('off: a code issued before the switch went off cannot sign anyone in', { skip }, async () => {
  const customer = await makeUser('customer', 'early@tickets.test', { mobile: null });
  const challenge = (await query<{ id: string }>(
    "INSERT INTO otp_challenges(contact,digest,expires_at) VALUES($1,$2,now()+interval '5 minutes') RETURNING id",
    ['early@tickets.test', security.keyedHash('early@tickets.test:123456')],
  ))[0];
  await assert.rejects(auth.verifyOtp(challenge.id, '123456'), OFF);
  assert.equal(await count('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [customer.id]), 0);
  // Switched back on, the same valid code works again: the switch is fully reversible.
  process.env.CUSTOMER_OTP_ENABLED = 'true';
  try {
    assert.equal((await auth.verifyOtp(challenge.id, '123456')).user.id, customer.id);
  } finally {
    delete process.env.CUSTOMER_OTP_ENABLED;
  }
});

test('off: Google (Clerk) sign-in still links a returning customer to the same account and booking history', { skip }, async () => {
  const show = await makeShow();
  const customer = await makeUser('customer', 'returning@tickets.test', { mobile: null });
  const co = await checkout.createCheckout(customer, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(customer, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, customer);
  const viaGoogle = await auth.ensureUserFromClerk('user_google_1', 'Returning@Tickets.test', 'Returning Fan');
  assert.equal(viaGoogle.id, customer.id, 'no duplicate account');
  assert.equal(viaGoogle.role, 'customer');
  assert.equal((await commerce.ownedBookings(viaGoogle.id)).length, 1, 'booking history kept');
  const fresh = await auth.ensureUserFromClerk('user_google_2', 'new@tickets.test');
  assert.equal(fresh.role, 'customer', 'a new Google customer gets an account');
});

test('off: staff passwords, both doors and role checks are unchanged', { skip }, async () => {
  await staff.upsertStaff({ contact: 'boss@tickets.test', role: 'owner', password: PASSWORD });
  await staff.upsertStaff({ contact: 'door@tickets.test', role: 'scanner', password: PASSWORD });
  const admin = await auth.loginStaff('boss@tickets.test', PASSWORD, 'admin', '10.9.0.3');
  const gate = await auth.loginStaff('door@tickets.test', PASSWORD, 'gate', '10.9.0.3');
  assert.equal((await auth.sessionUser(admin.sessionToken!))?.role, 'owner');
  assert.equal((await auth.sessionUser(gate.sessionToken!))?.role, 'scanner');
  await assert.rejects(auth.loginStaff('door@tickets.test', PASSWORD, 'admin', '10.9.0.3'), 'the gate role is refused at the admin door');
  const customer = await makeUser();
  assert.throws(() => auth.assertRole(customer, ['owner', 'inventory']), /permission/);
});

test('off: adding a mobile to a signed-in account is not sign-in and still works (mobile features on)', { skip }, async () => {
  const customer = await makeUser('customer', 'adder@tickets.test', { mobile: null });
  const { challengeId } = await contacts.requestMobileVerification(customer.id, '+919876500077', '10.9.0.4');
  assert.ok(challengeId);
  assert.equal(fake.sms.length, 1, 'the verification code went to the mobile');
});
