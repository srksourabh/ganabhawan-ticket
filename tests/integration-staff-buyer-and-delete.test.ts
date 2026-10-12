/**
 * 1. Staff as buyers: a staff member signed in with Google/Clerk is the SAME account
 *    acting as a customer (no staff powers through Clerk); with the password door they
 *    keep their role. Either way they buy through the normal checkout and payment at the
 *    normal price, and see only their own tickets.
 * Real auth, checkout and payment code on the local test
 * database; Razorpay/Resend are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { Role, User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const PASSWORD = 'staff password long enough';
let auth: typeof import('../src/lib/auth');
let staff: typeof import('../src/lib/staff');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  auth = await import('../src/lib/auth');
  staff = await import('../src/lib/staff');
  checkout = await import('../src/lib/checkout');
  commerce = await import('../src/lib/commerce');
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

async function staffMember(role: Role) {
  const contact = `${role}-${randomUUID().slice(0, 6)}@tickets.test`;
  await staff.upsertStaff({ contact, role, password: PASSWORD });
  return contact;
}

/** Normal checkout → Razorpay order → signed callback. Returns what was charged. */
async function buy(buyer: User, productId: string, quantity = 1) {
  const co = await checkout.createCheckout(buyer, [{ productId, quantity, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(buyer, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, buyer);
  return { co, amount: Number(order.amount) };
}

// ---- STAFF AS BUYERS --------------------------------------------------------------------------------

test('staff via Google/Clerk: every staff role buys at the normal price as a buyer of its own account; no staff powers', { skip }, async () => {
  const show = await makeShow({ price: 40000, allocation: 20 });
  for (const role of ['owner', 'inventory', 'finance', 'desk', 'scanner', 'supervisor'] as Role[]) {
    const contact = await staffMember(role);
    const before = await count('SELECT count(*)::int n FROM users');
    const buyer = await auth.ensureUserFromClerk(`clerk_${role}`, contact, 'Staff Buyer');
    assert.equal(await count('SELECT count(*)::int n FROM users'), before, `${role}: no duplicate account`);
    const stored = (await query<{ id: string; role: string }>('SELECT id, role FROM users WHERE contact=$1', [contact]))[0];
    assert.deepEqual([buyer.id, buyer.role, stored.role], [stored.id, 'customer', role], `${role}: same account, buyer session, stored role kept`);
    assert.throws(() => auth.assertRole(buyer, ['owner', 'inventory', 'finance', 'scanner', 'supervisor']), /permission/, `${role}: no staff function via Clerk`);

    const { co, amount } = await buy(buyer, show.productId, 2);
    assert.equal(amount, 2 * 40000, `${role}: charged the normal price`);
    const receipt = await checkout.checkoutReceipt(buyer.id, co.id);
    assert.equal(receipt.status, 'CONFIRMED');
    const owned = (await commerce.ownedBookings(buyer.id)) as { checkout_id: string; tickets: unknown[] }[];
    assert.ok(owned.some((b) => b.checkout_id === co.id && b.tickets.length === 2), `${role}: tickets under My tickets`);
  }
});

test('staff via the password door keep their role and can also buy normally; they cannot read another customer’s booking', { skip }, async () => {
  const show = await makeShow({ price: 30000 });
  const contact = await staffMember('inventory');
  const session = await auth.loginStaff(contact, PASSWORD, 'admin', '10.6.0.1');
  const who = (await auth.sessionUser(session.sessionToken!))!;
  assert.equal(who.role, 'inventory');
  const { co, amount } = await buy(who, show.productId);
  assert.equal(amount, 30000);
  assert.equal((await checkout.checkoutReceipt(who.id, co.id)).status, 'CONFIRMED');

  const customer = await makeUser();
  const theirs = await buy(customer, show.productId);
  await assert.rejects(checkout.checkoutReceipt(who.id, theirs.co.id), 'staff cannot open a customer receipt');
  const bookingId = (await query<{ id: string }>('SELECT id FROM bookings WHERE checkout_id=$1', [theirs.co.id]))[0].id;
  assert.deepEqual(await commerce.ownedBookings(who.id, bookingId), []);
});

test('customer sign-in paths are unchanged: Clerk maps an existing customer to the same account; OTP never opens a staff account', { skip }, async () => {
  const customer = await makeUser('customer', 'fan@tickets.test', { mobile: null });
  assert.equal((await auth.ensureUserFromClerk('clerk_fan', 'Fan@Tickets.test')).id, customer.id);
  assert.equal((await auth.ensureUserFromClerk('clerk_fan', 'fan@tickets.test')).role, 'customer');
  const fresh = await auth.ensureUserFromClerk('clerk_new', 'new@tickets.test', 'New Fan');
  assert.equal(fresh.role, 'customer');
  const contact = await staffMember('owner');
  const { keyedHash } = await import('../src/lib/security');
  const challenge = (await query<{ id: string }>(
    "INSERT INTO otp_challenges(contact,digest,expires_at) VALUES($1,$2,now()+interval '5 minutes') RETURNING id", [contact, keyedHash(contact + ':123456')]))[0];
  await assert.rejects(auth.verifyOtp(challenge.id, '123456'), /Staff accounts sign in/);
});
