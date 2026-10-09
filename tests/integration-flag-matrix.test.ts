/**
 * The configuration matrix: ALLOW_PUBLIC_SALES (business switch) × sales settings ×
 * MOBILE_PHONE_NUMBER_ENABLED. For each row: can an email customer check out, is
 * mobile sign-in available, what /api/health reports, and do staff still sign in.
 * Real checkout/auth/health code on the local test database; providers are fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const MSG91 = { SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'test-auth-key', MSG91_OTP_TEMPLATE_ID: 'tmpl-otp', MSG91_TEMPLATE_ID: 'tmpl-confirm' };
const NO_MSG91 = { SMS_PROVIDER: undefined, MSG91_AUTH_KEY: undefined, MSG91_OTP_TEMPLATE_ID: undefined, MSG91_TEMPLATE_ID: undefined };
const PASSWORD = 'staff password long enough';
let auth: typeof import('../src/lib/auth');
let checkout: typeof import('../src/lib/checkout');
let staff: typeof import('../src/lib/staff');
let health: typeof import('../app/api/health/route');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  auth = await import('../src/lib/auth');
  checkout = await import('../src/lib/checkout');
  staff = await import('../src/lib/staff');
  health = await import('../app/api/health/route');
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

type Row = {
  name: string;
  env: Record<string, string | undefined>;
  sales: boolean; // an email-only customer can check out
  mobile: boolean; // mobile sign-in available
  config: boolean; // /api/health config (sales settings valid)
};

const ROWS: Row[] = [
  { name: 'switch false, settings valid, mobile false', env: { ALLOW_PUBLIC_SALES: 'false', MOBILE_PHONE_NUMBER_ENABLED: 'false', ...NO_MSG91 }, sales: false, mobile: false, config: true },
  { name: 'switch false, settings valid, mobile true + MSG91', env: { ALLOW_PUBLIC_SALES: 'false', MOBILE_PHONE_NUMBER_ENABLED: 'true', ...MSG91 }, sales: false, mobile: true, config: true },
  { name: 'switch true, settings valid, mobile false (email-only launch)', env: { ALLOW_PUBLIC_SALES: 'true', MOBILE_PHONE_NUMBER_ENABLED: 'false', ...NO_MSG91 }, sales: true, mobile: false, config: true },
  { name: 'switch true, settings valid, mobile true + MSG91', env: { ALLOW_PUBLIC_SALES: 'true', MOBILE_PHONE_NUMBER_ENABLED: 'true', ...MSG91 }, sales: true, mobile: true, config: true },
  { name: 'switch true, settings valid, mobile true, MSG91 missing', env: { ALLOW_PUBLIC_SALES: 'true', MOBILE_PHONE_NUMBER_ENABLED: 'true', ...NO_MSG91 }, sales: true, mobile: false, config: true },
  { name: 'switch true, email settings missing, mobile false', env: { ALLOW_PUBLIC_SALES: 'true', MOBILE_PHONE_NUMBER_ENABLED: 'false', RESEND_API_KEY: undefined, ...NO_MSG91 }, sales: false, mobile: false, config: false },
  { name: 'switch true, payment settings invalid (live key on staging), mobile false', env: { ALLOW_PUBLIC_SALES: 'true', MOBILE_PHONE_NUMBER_ENABLED: 'false', RAZORPAY_KEY_ID: 'rzp_live_wrong', ...NO_MSG91 }, sales: false, mobile: false, config: false },
  { name: 'switch missing, settings valid, mobile false', env: { ALLOW_PUBLIC_SALES: undefined, MOBILE_PHONE_NUMBER_ENABLED: 'false', ...NO_MSG91 }, sales: false, mobile: false, config: true },
  { name: 'switch malformed ("TRUE"), mobile malformed ("1") with MSG91', env: { ALLOW_PUBLIC_SALES: 'TRUE', MOBILE_PHONE_NUMBER_ENABLED: '1', ...MSG91 }, sales: false, mobile: false, config: true },
  { name: 'switch malformed ("yes"), mobile malformed ("on")', env: { ALLOW_PUBLIC_SALES: 'yes', MOBILE_PHONE_NUMBER_ENABLED: 'on', ...MSG91 }, sales: false, mobile: false, config: true },
];

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

for (const row of ROWS) {
  test(`matrix: ${row.name}`, { skip }, async () => {
    const show = await makeShow();
    const customer = await makeUser('customer', `buyer-${randomUUID().slice(0, 6)}@tickets.test`, { mobile: null });
    await staff.upsertStaff({ contact: 'owner@tickets.test', role: 'owner', password: PASSWORD });
    await staff.upsertStaff({ contact: 'gate@tickets.test', role: 'scanner', password: PASSWORD });
    await withEnv(row.env, async () => {
      const bought = await checkout.createCheckout(customer, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID())
        .then(() => true, () => false);
      assert.equal(bought, row.sales, 'email-only checkout');
      if (!row.sales) assert.equal((await query('SELECT count(*)::int n FROM checkouts'))[0].n, 0, 'nothing held');

      const mobileTry = await auth.requestOtp('+919876533001', '10.5.0.1').then(() => 'sent', (e) => e.code);
      if (row.mobile) assert.equal(mobileTry, row.config ? 'sent' : 'CONFIG_INVALID');
      else assert.ok(['MOBILE_DISABLED', 'CONFIG_INVALID'].includes(mobileTry), `mobile refused (${mobileTry})`);
      if (!row.mobile) assert.equal(fake.sms.length, 0, 'no SMS provider call');

      const body = await (await health.GET()).json();
      assert.deepEqual(
        { config: body.config, publicSales: body.publicSales, mobile: body.mobile, staff: body.staff },
        { config: row.config, publicSales: row.sales, mobile: row.mobile, staff: true },
      );
      assert.ok(!JSON.stringify(body).match(/rzp_|re_integration|test-auth-key|tmpl-/), 'health reveals no setting value');

      // Staff access follows core settings and roles only.
      assert.equal((await auth.loginStaff('owner@tickets.test', PASSWORD, 'admin', '10.5.0.2')).user.role, 'owner');
      assert.equal((await auth.loginStaff('gate@tickets.test', PASSWORD, 'gate', '10.5.0.2')).user.role, 'scanner');
      assert.equal((await auth.loginStaff('gate@tickets.test', PASSWORD, 'admin', '10.5.0.2').catch((e) => e)).code, 'WRONG_PORTAL');
    });
  });
}
