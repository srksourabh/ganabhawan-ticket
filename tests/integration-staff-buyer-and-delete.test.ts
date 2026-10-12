/**
 * 1. Staff as buyers: a staff member signed in with Google/Clerk is the SAME account
 *    acting as a customer (no staff powers through Clerk); with the password door they
 *    keep their role. Either way they buy through the normal checkout and payment at the
 *    normal price, and see only their own tickets.
 * 2. Programme deletion (catalogue.ts deleteShow): only a programme with no history is
 *    deleted; anything sold, reserved, ledgered, scanned or in a season is refused with
 *    the reason, and nothing historical is touched.
 * Real auth, checkout, payment, catalogue and admission code on the local test
 * database; Razorpay/Resend are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeSeason, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { Role, User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const PASSWORD = 'staff password long enough';
let auth: typeof import('../src/lib/auth');
let staff: typeof import('../src/lib/staff');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let catalogue: typeof import('../src/lib/catalogue');
let inventoryAdmin: typeof import('../src/lib/inventory-admin');
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
  catalogue = await import('../src/lib/catalogue');
  inventoryAdmin = await import('../src/lib/inventory-admin');
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

// ---- PROGRAMME DELETION -----------------------------------------------------------------------------

test('delete: owner and inventory delete an untouched programme permanently (with its zones, pools, products and saved-cart lines); audited', { skip }, async () => {
  for (const role of ['owner', 'inventory'] as Role[]) {
    const admin = await makeUser(role);
    const show = await makeShow();
    const customer = await makeUser();
    await query('INSERT INTO cart_items(user_id,product_id,quantity) VALUES($1,$2,1)', [customer.id, show.productId]);
    assert.deepEqual(await catalogue.deleteShow(admin, show.showId), { deleted: true, id: show.showId });
    for (const [table, where] of [['shows', 'id'], ['capacities', 'show_id'], ['product_coverage', 'show_id'], ['staff_scopes', 'show_id']]) {
      assert.equal(await count(`SELECT count(*)::int n FROM ${table} WHERE ${where}=$1`, [show.showId]), 0, `${table} cleaned`);
    }
    assert.equal(await count('SELECT count(*)::int n FROM products WHERE id=$1', [show.productId]), 0);
    assert.equal(await count('SELECT count(*)::int n FROM pools WHERE id=$1', [show.poolId]), 0);
    assert.equal(await count('SELECT count(*)::int n FROM cart_items WHERE product_id=$1', [show.productId]), 0, 'the stale cart line is gone');
    const audit = (await query<{ actor_id: string }>("SELECT actor_id FROM audit_events WHERE action='show.delete' AND entity=$1", [show.showId]))[0];
    assert.equal(audit.actor_id, admin.id);
    // The deleted programme cannot be bought or shown.
    await assert.rejects(checkout.createCheckout(customer, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID()));
    assert.ok(!(await catalogue.catalogue()).shows.some((s) => s.id === show.showId));
  }
});

test('delete: customers and other staff roles are refused; unknown and malformed ids are 404; a second concurrent delete is 404, never 500', { skip }, async () => {
  const show = await makeShow();
  for (const role of ['customer', 'finance', 'desk', 'scanner', 'supervisor'] as Role[]) {
    const error = await catalogue.deleteShow(await makeUser(role), show.showId).catch((e) => e);
    assert.equal(error.status, 403, role);
  }
  const owner = await makeUser('owner');
  assert.equal((await catalogue.deleteShow(owner, randomUUID()).catch((e) => e)).status, 404);
  assert.equal((await catalogue.deleteShow(owner, 'not-a-uuid').catch((e) => e)).status, 404);
  const results = await Promise.allSettled([catalogue.deleteShow(owner, show.showId), catalogue.deleteShow(owner, show.showId)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.status, 404);
});

test('delete: a programme with a paid booking is refused; booking, tickets, payment and gate admission are untouched', { skip }, async () => {
  const owner = await makeUser('owner');
  const show = await makeShow({ startsInMinutes: 30 });
  const customer = await makeUser();
  const { co } = await buy(customer, show.productId, 2);
  const snapshot = async () => ({
    bookings: await count("SELECT count(*)::int n FROM bookings WHERE checkout_id=$1 AND status='CONFIRMED'", [co.id]),
    tickets: await count("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND t.status='ACTIVE'", [co.id]),
    payments: await count("SELECT count(*)::int n FROM payments WHERE checkout_id=$1 AND state='CAPTURED'", [co.id]),
  });
  const beforeDelete = await snapshot();
  const error = await catalogue.deleteShow(owner, show.showId).catch((e) => e);
  assert.equal(error.code, 'PROGRAMME_HAS_BOOKINGS');
  assert.equal(error.status, 409);
  assert.deepEqual(await snapshot(), beforeDelete);
  assert.deepEqual(beforeDelete, { bookings: 1, tickets: 2, payments: 1 });
  assert.equal(await count('SELECT count(*)::int n FROM shows WHERE id=$1', [show.showId]), 1);
  const owned = (await commerce.ownedBookings(customer.id)) as { tickets: unknown[] }[];
  assert.equal(owned[0].tickets.length, 2, 'still under My tickets');

  const admission = await import('../src/lib/admission');
  const { decrypt } = await import('../src/lib/security');
  const scanner = await makeUser('scanner');
  await query(`INSERT INTO devices(id,name) VALUES('gate-one','Main') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO staff_scopes(user_id,show_id,gate,device_id) VALUES($1,$2,'gate-one','gate-one')`, [scanner.id, show.showId]);
  const token = decrypt((await query<{ encrypted_token: string }>(
    "SELECT c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND c.status='ACTIVE' LIMIT 1", [co.id]))[0].encrypted_token);
  assert.equal((await admission.admit(scanner, { requestId: randomUUID(), ticketToken: token, showId: show.showId, gateId: 'gate-one', deviceId: 'gate-one' })).result, 'ADMITTED');
});

test('delete: an expired, unpaid hold also blocks deletion (it is a booking record); the programme stays', { skip }, async () => {
  const owner = await makeUser('owner');
  const show = await makeShow();
  const customer = await makeUser();
  await commerce.reserve(customer, { productId: show.productId, quantity: 1, version: 1 }, randomUUID());
  await query("UPDATE bookings SET expires_at=now()-interval '1 minute'");
  await commerce.expireHolds();
  assert.equal((await catalogue.deleteShow(owner, show.showId).catch((e) => e)).code, 'PROGRAMME_HAS_BOOKINGS');
});

test('delete: inventory-ledger history is refused with the unpublish alternative, which hides it from the public site', { skip }, async () => {
  const owner = await makeUser('owner');
  const show = await makeShow();
  const capacityId = (await query<{ id: string }>('SELECT id FROM capacities WHERE show_id=$1', [show.showId]))[0].id;
  await inventoryAdmin.configureCapacity(owner, capacityId, { ceiling: 500, dailyAllocation: 12, onlineSeasonAllocation: 50, seasonAllocation: 50 });
  assert.ok(await count('SELECT count(*)::int n FROM movements WHERE pool_id=$1', [show.poolId]) > 0, 'a ledger entry exists');
  const error = await catalogue.deleteShow(owner, show.showId).catch((e) => e);
  assert.equal(error.code, 'PROGRAMME_HAS_HISTORY');
  assert.match(error.message, /Unpublish it/);
  await catalogue.updateShow(owner, show.showId, { status: 'DRAFT' });
  assert.ok(!(await catalogue.catalogue()).shows.some((s) => s.id === show.showId), 'unpublished: off the public site');
  await assert.rejects(commerce.reserve(await makeUser(), { productId: show.productId, quantity: 1, version: 1 }, randomUUID()), 'and not sellable');
});

test('delete: a programme in a season ticket is refused (deleting it would change what season buyers bought)', { skip }, async () => {
  const owner = await makeUser('owner');
  const a = await makeShow();
  const b = await makeShow();
  await makeSeason([a, b]);
  const error = await catalogue.deleteShow(owner, a.showId).catch((e) => e);
  assert.equal(error.code, 'PROGRAMME_IN_SEASON');
  assert.equal(await count('SELECT count(*)::int n FROM product_coverage WHERE show_id=$1', [a.showId]), 2);
});

test('delete racing a purchase: never both — either the programme is deleted and the hold refused, or the hold exists and deletion is refused', { skip }, async () => {
  for (let i = 0; i < 5; i++) {
    await resetDatabase();
    const owner = await makeUser('owner');
    const show = await makeShow();
    const customer = await makeUser();
    const [del, hold] = await Promise.allSettled([
      catalogue.deleteShow(owner, show.showId),
      commerce.reserve(customer, { productId: show.productId, quantity: 1, version: 1 }, randomUUID()),
    ]);
    assert.ok(!(del.status === 'fulfilled' && hold.status === 'fulfilled'), 'not both');
    assert.ok(del.status === 'fulfilled' || hold.status === 'fulfilled', 'one of them wins');
    const bookings = await count('SELECT count(*)::int n FROM bookings');
    const shows = await count('SELECT count(*)::int n FROM shows WHERE id=$1', [show.showId]);
    assert.ok((bookings === 0 && shows === 0) || (bookings === 1 && shows === 1), `consistent (${bookings} bookings, ${shows} shows)`);
  }
});
