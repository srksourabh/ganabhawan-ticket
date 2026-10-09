/**
 * "Sales readiness controls CUSTOMER SALES, not INTERNAL ADMINISTRATION."
 * With customer-sales settings missing (here: email delivery, then Razorpay), staff
 * still sign in, administer and scan; every customer purchase path stays
 * blocked; and once sales are configured the purchase flow works as before.
 * Real staff login, real purchase functions and the real proxy decision
 * (config-gate.ts); only the payment/SMS/email providers are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const PASSWORD = 'staff password long enough';
let auth: typeof import('../src/lib/auth');
let staff: typeof import('../src/lib/staff');
let commerce: typeof import('../src/lib/commerce');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let admission: typeof import('../src/lib/admission');
let gate: typeof import('../src/lib/config-gate');
let env: typeof import('../src/lib/env');
let query: typeof import('../src/lib/db').query;

// MSG91 is no longer a sales setting (MOBILE_PHONE_NUMBER_ENABLED); email delivery is.
const EMAIL = ['RESEND_API_KEY', 'EMAIL_FROM'] as const;
const RAZORPAY = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const;
function without<T>(names: readonly string[], run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  return run().finally(() => { for (const [n, v] of Object.entries(saved)) if (v !== undefined) process.env[n] = v; });
}

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  auth = await import('../src/lib/auth');
  staff = await import('../src/lib/staff');
  commerce = await import('../src/lib/commerce');
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  admission = await import('../src/lib/admission');
  gate = await import('../src/lib/config-gate');
  env = await import('../src/lib/env');
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

async function account(role: 'owner' | 'scanner' | 'supervisor' | 'inventory') {
  const contact = `${role}-${randomUUID().slice(0, 6)}@tickets.test`;
  await staff.upsertStaff({ contact, role, password: PASSWORD });
  return contact;
}

for (const [label, missing] of [['email delivery not configured', EMAIL], ['Razorpay not configured', RAZORPAY]] as const) {
  test(`sales not ready (${label}): owner signs in at /admin/login and scanner/supervisor at /gate/login`, { skip }, async () => {
    const show = await makeShow({ startsInMinutes: 30 }); // before staff, so scanners are scoped to it
    const owner = await account('owner');
    const scanner = await account('scanner');
    const supervisor = await account('supervisor');
    await without(missing, async () => {
      assert.ok(env.salesConfigurationProblems().length > 0, 'customer sales are NOT ready');
      assert.deepEqual(env.coreConfigurationProblems(), [], 'core settings are fine');
      assert.equal((await auth.loginStaff(owner, PASSWORD, 'admin', '10.9.0.1')).user.role, 'owner');
      for (const [contact, role] of [[scanner, 'scanner'], [supervisor, 'supervisor']] as const) {
        const session = await auth.loginStaff(contact, PASSWORD, 'gate', '10.9.0.1');
        assert.equal(session.user.role, role);
        const who = (await auth.sessionUser(session.sessionToken!))!;
        // Admission checks run normally (an unknown code is UNKNOWN, not a config error).
        const scan = await admission.admit(who, { requestId: randomUUID(), ticketToken: 'not-a-ticket', showId: show.showId, gateId: 'gate-one', deviceId: 'gate-one' });
        assert.equal(scan.result, 'UNKNOWN');
      }
    });
  });

  test(`sales not ready (${label}): every customer purchase path stays blocked; nothing is held or ordered`, { skip }, async () => {
    const show = await makeShow();
    const customer = await makeUser();
    await without(missing, async () => {
      for (const attempt of [
        () => checkout.createCheckout(customer, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID()),
        () => commerce.reserve(customer, { productId: show.productId, quantity: 1, version: 1 }, randomUUID()),
        () => auth.requestOtp(customer.contact, '10.9.0.2'),
      ]) {
        const error = await attempt().catch((e) => e);
        assert.equal(error.code, 'CONFIG_INVALID', String(error.message));
        assert.match(error.message, /not configured for sales/);
      }
    });
    assert.equal((await query('SELECT count(*)::int n FROM bookings'))[0].n, 0);
    assert.equal((await query('SELECT count(*)::int n FROM checkouts'))[0].n, 0);
    assert.equal(fake.count('POST /orders'), 0);
    assert.equal(fake.sms.length + fake.emails.length, 0);
  });

  test(`sales not ready (${label}): the proxy allows only staff/internal APIs; customer APIs get CONFIG_INVALID`, { skip }, async () => {
    await without(missing, async () => {
      for (const path of ['/api/auth/password', '/api/auth/logout', '/api/auth/me', '/api/admin/me', '/api/admin/staff', '/api/admin/inventory',
        '/api/admin/metrics', '/api/admission/scan', '/api/ops/status', '/api/posters/abc']) {
        assert.equal(gate.apiRefusal(path), null, `${path} allowed for staff`);
      }
      for (const path of ['/api/checkouts', '/api/holds', '/api/payments/order', '/api/payments/confirm', '/api/payments/sync', '/api/cart',
        '/api/cart/merge', '/api/account/mobile', '/api/auth/otp/request', '/api/auth/otp/verify', '/api/auth/clerk/sync',
        '/api/booking-attempts', '/api/bookings', '/api/tickets/x/resend', '/api/cron/worker', '/api/auth/password-reset', '/api/adminx']) {
        assert.match(String(gate.apiRefusal(path)), /not configured for sales/, `${path} blocked`);
      }
    });
  });
}

test('sales not ready: unauthorised users still cannot reach admin or gate areas (roles enforced as before)', { skip }, async () => {
  const scanner = await account('scanner');
  const inventory = await account('inventory');
  const customer = await makeUser();
  await without(EMAIL, async () => {
    for (const [contact, door] of [[scanner, 'admin'], [inventory, 'gate']] as const) {
      const refused = await auth.loginStaff(contact, PASSWORD, door, '10.9.0.3').catch((e) => e);
      assert.equal(refused.code, 'WRONG_PORTAL');
    }
    await assert.rejects(auth.loginStaff(customer.contact, PASSWORD, 'admin', '10.9.0.3'), /Incorrect email or password/);
    const customerUser = { ...customer };
    assert.throws(() => auth.assertRole(customerUser, ['owner', 'inventory']), /permission/);
    await assert.rejects(admission.admit(customerUser, { requestId: randomUUID(), ticketToken: 'x', showId: randomUUID(), gateId: 'gate-one', deviceId: 'gate-one' }), /permission/);
  });
});

test('broken CORE settings still stop everything, staff included (fail closed)', { skip }, async () => {
  const owner = await account('owner');
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'too-short';
  try {
    assert.match(String(gate.apiRefusal('/api/auth/password')), /not configured yet/);
    assert.match(String(gate.apiRefusal('/api/admin/staff')), /not configured yet/);
    await assert.rejects(auth.loginStaff(owner, PASSWORD, 'admin', '10.9.0.4'), /not configured yet/);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

test('sales ready: the customer purchase flow works as before (checkout → one order → payment → CONFIRMED)', { skip }, async () => {
  assert.deepEqual(env.configurationProblems(), []);
  assert.equal(gate.apiRefusal('/api/checkouts'), null);
  const show = await makeShow();
  const customer = await makeUser();
  const co = await checkout.createCheckout(customer, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(customer, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, customer);
  assert.equal((await checkout.checkoutReceipt(customer.id, co.id)).status, 'CONFIRMED');
});
