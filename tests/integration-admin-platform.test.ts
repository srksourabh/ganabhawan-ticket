/**
 * Admin-configured inventory, season allocation, server-authoritative
 * availability, the hold lifecycle, scan logging, metrics, staff management,
 * post-payment email + SMS and line-level receipt status. Local database and
 * the in-process fake Razorpay/Resend/MSG91 only.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, expireNow, makeFestival, makeSeason, makeShow, makeUser, resetDatabase, useLiveStagingEnv, webhook } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let checkout: typeof import('../src/lib/checkout');
let catalogue: typeof import('../src/lib/catalogue');
let inventory: typeof import('../src/lib/inventory-admin');
let jobs: typeof import('../src/lib/jobs');
let admission: typeof import('../src/lib/admission');
let staff: typeof import('../src/lib/staff');
let metrics: typeof import('../src/lib/metrics');
let auth: typeof import('../src/lib/auth');
let query: typeof import('../src/lib/db').query;


before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  checkout = await import('../src/lib/checkout');
  catalogue = await import('../src/lib/catalogue');
  inventory = await import('../src/lib/inventory-admin');
  jobs = await import('../src/lib/jobs');
  admission = await import('../src/lib/admission');
  staff = await import('../src/lib/staff');
  metrics = await import('../src/lib/metrics');
  auth = await import('../src/lib/auth');
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

const reserve = (user: User, productId: string, quantity = 1) =>
  commerce.reserve(user, { productId, quantity, version: 1 }, randomUUID()) as Promise<{ id: string }>;

async function pay(user: User, bookingId: string, status: 'captured' | 'failed' = 'captured') {
  const order = await payments.createPaymentOrder(user, bookingId);
  const p = fake.pay(order.orderId, { status });
  if (status !== 'captured') return { order, payment: p };
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return { order, payment: p };
}

async function capacityOf(showId: string) {
  return (await query<{ id: string }>("SELECT id FROM capacities WHERE show_id=$1 AND zone='Premier'", [showId]))[0].id;
}
const pools = async (showId: string) => Object.fromEntries((await query<{ kind: string; allocation: number; held: number; committed: number }>(
  `SELECT p.kind, p.allocation, p.held, p.committed FROM pools p JOIN capacities c ON c.id=p.capacity_id WHERE c.show_id=$1`, [showId])).map((r) => [r.kind, r]));

/** Two performances configured 300 total / 50 season / 250 daily / 20 online season, plus a season ticket over both. */
async function festivalWithSeason(owner: User) {
  const a = await makeShow({ allocation: 10 });
  const b = await makeShow({ allocation: 10 });
  for (const s of [a, b]) {
    await inventory.configureCapacity(owner, await capacityOf(s.showId), { ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 20 });
  }
  const season = await makeSeason([a, b]);
  return { a, b, season };
}

// ---- SEASON / INVENTORY --------------------------------------------------------------------------

test('season: 300/50/250 with 20 online — 20 season tickets sell, the 21st is refused; daily stock is untouched', { skip }, async () => {
  const owner = await makeUser('owner');
  const { a, b, season } = await festivalWithSeason(owner);
  for (let i = 0; i < 4; i += 1) { const u = await makeUser(); await pay(u, (await reserve(u, season.productId, 5)).id); } // 4 × 5 = 20
  assert.equal((await pools(a.showId)).SEASON.committed, 20);
  assert.equal((await pools(b.showId)).SEASON.committed, 20, 'a season ticket takes a seat in every covered show');
  await assert.rejects(reserve(await makeUser(), season.productId, 1), /Not enough tickets remain/, 'the 21st online season ticket is refused');
  assert.deepEqual([(await pools(a.showId)).DAILY.held, (await pools(a.showId)).DAILY.committed], [0, 0], 'season sales never touch daily stock');
  const daily = await makeUser();
  await pay(daily, (await reserve(daily, a.productId, 2)).id);
  assert.equal((await pools(a.showId)).DAILY.committed, 2);
  assert.equal((await pools(a.showId)).SEASON.committed, 20, 'daily sales never touch season stock');
});

test('season: last online season seat, 10 concurrent buyers → exactly one hold', { skip }, async () => {
  const owner = await makeUser('owner');
  const { a, b, season } = await festivalWithSeason(owner);
  for (const s of [a, b]) await inventory.configureCapacity(owner, await capacityOf(s.showId), { ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 1 });
  const buyers = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
  const results = await Promise.allSettled(buyers.map((u) => reserve(u, season.productId)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await pools(a.showId)).SEASON.held, 1);
});

test('inventory: allocations cannot go below what is sold or held; invariants hold even for direct SQL', { skip }, async () => {
  const owner = await makeUser('owner');
  const { a, season } = await festivalWithSeason(owner);
  const u = await makeUser();
  await pay(u, (await reserve(u, season.productId, 3)).id);
  const cap = await capacityOf(a.showId);
  await assert.rejects(inventory.configureCapacity(owner, cap, { ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 2 }), /cannot go below 3/);
  await assert.rejects(inventory.configureCapacity(owner, cap, { ceiling: 300, seasonAllocation: 60, dailyAllocation: 250, onlineSeasonAllocation: 20 }), /cannot exceed the zone capacity/);
  // The database trigger is the backstop for any other write path.
  await assert.rejects(query("UPDATE pools SET allocation=60 WHERE kind='SEASON' AND capacity_id=$1", [cap]), /online season allocation/);
  const stale = (await query<{ version: number }>('SELECT version FROM capacities WHERE id=$1', [cap]))[0].version - 1;
  await assert.rejects(inventory.configureCapacity(owner, cap, { version: stale, ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 20 }), /changed/);
  const audits = await query("SELECT count(*)::int n FROM audit_events WHERE action='inventory.configure'");
  assert.ok(audits[0].n >= 2, 'every change is audited');
});

test('inventory: season allocation for a zone applies to every upcoming show at once (all or nothing)', { skip }, async () => {
  const owner = await makeUser('owner');
  const { a, b } = await festivalWithSeason(owner);
  const result = await inventory.configureSeasonForZone(owner, 'Premier', { seasonAllocation: 40, onlineSeasonAllocation: 15 });
  assert.equal(result.shows, 2);
  assert.equal((await pools(a.showId)).SEASON.allocation, 15);
  assert.equal((await pools(b.showId)).SEASON.allocation, 15);
  await assert.rejects(inventory.configureSeasonForZone(owner, 'Premier', { seasonAllocation: 10, onlineSeasonAllocation: 15 }), /cannot exceed the season allocation/);
  assert.equal((await pools(a.showId)).SEASON.allocation, 15, 'a refused change leaves every show as it was');
});

test('admin: season ticket creation, show creation copies the configured zones (no hardcoded prices or capacity)', { skip }, async () => {
  const owner = await makeUser('owner');
  await makeFestival();
  const showInput = { title: 'Play X', titleBn: 'নাটক', troupe: 'T', synopsis: 'S', synopsisBn: 'S', startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), runtime: 120, genre: 'Drama', status: 'PUBLISHED' };
  const first = await catalogue.upsertShow(owner, showInput);
  const firstZones = await query<{ ceiling: number; enabled: boolean; price: number }>(
    `SELECT c.ceiling, p.enabled, p.price FROM capacities c JOIN products p ON p.show_id=c.show_id AND p.category=c.zone WHERE c.show_id=$1`, [first.id]);
  assert.ok(firstZones.every((z) => z.ceiling === 0 && z.enabled === false), 'the first show is not sellable until configured');
  await inventory.configureCapacity(owner, (await query<{ id: string }>("SELECT id FROM capacities WHERE show_id=$1 AND zone='Premier'", [first.id]))[0].id,
    { ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 20 });
  await query("UPDATE products SET price=60000, enabled=true WHERE show_id=$1 AND category='Premier'", [first.id]);
  const second = await catalogue.upsertShow(owner, { ...showInput, title: 'Play Y', startsAt: new Date(Date.now() + 10 * 86_400_000).toISOString() });
  const copied = (await query<{ ceiling: number; season_allocation: number; price: number; enabled: boolean }>(
    `SELECT c.ceiling, c.season_allocation, p.price, p.enabled FROM capacities c JOIN products p ON p.show_id=c.show_id AND p.category=c.zone WHERE c.show_id=$1 AND c.zone='Premier'`, [second.id]))[0];
  assert.deepEqual(copied, { ceiling: 300, season_allocation: 50, price: 60000, enabled: true });
  const season = await inventory.createSeasonProduct(owner, { category: 'Premier', name: 'Premier Season', nameBn: 'প্রিমিয়ার সিজন', price: 160000 });
  assert.equal(season.coverage, 2);
  await assert.rejects(inventory.createSeasonProduct(owner, { category: 'Premier', name: 'Again', nameBn: 'আবার', price: 1 }), /already exists/);
});

test('season coverage: a new performance does NOT join an existing season by itself; the admin adds it explicitly, only before any sale', { skip }, async () => {
  const owner = await makeUser('owner');
  const { a, b, season } = await festivalWithSeason(owner);
  const showInput = { title: 'Late addition', titleBn: 'নতুন', troupe: 'T', synopsis: 'S', synopsisBn: 'S', startsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), runtime: 90, genre: 'Drama', status: 'PUBLISHED' };
  const created = await catalogue.upsertShow(owner, showInput);
  const coverage = async () => (await query<{ show_id: string }>('SELECT show_id FROM product_coverage WHERE product_id=$1 ORDER BY show_id', [season.productId])).map((r) => r.show_id).sort();
  assert.deepEqual(await coverage(), [a.showId, b.showId].sort(), 'season coverage unchanged by show creation');

  const before = (await query<{ version: number }>('SELECT version FROM products WHERE id=$1', [season.productId]))[0].version;
  await inventory.addShowToSeason(owner, season.productId, created.id);
  assert.deepEqual(await coverage(), [a.showId, b.showId, created.id].sort());
  assert.equal((await query<{ version: number }>('SELECT version FROM products WHERE id=$1', [season.productId]))[0].version, before + 1, 'carts holding the old season ticket must re-add it');
  await assert.rejects(inventory.addShowToSeason(owner, season.productId, created.id), /already part/);
  assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE action='product.season.add_show'"))[0].n, 1);

  // Once a season ticket is sold, its performances can no longer change.
  const buyer = await makeUser();
  const hold = (await commerce.reserve(buyer, { productId: season.productId, quantity: 1, version: before + 1 }, randomUUID())) as { id: string };
  await pay(buyer, hold.id);
  const another = await catalogue.upsertShow(owner, { ...showInput, title: 'Too late', startsAt: new Date(Date.now() + 21 * 86_400_000).toISOString() });
  await assert.rejects(inventory.addShowToSeason(owner, season.productId, another.id), /already been sold/);
  assert.equal((await coverage()).length, 3, 'existing season customers keep exactly what they bought');
});

// ---- AVAILABILITY ---------------------------------------------------------------------------------

test('availability: a season covering a not-yet-published show is CLOSED in the catalogue AND refused at checkout — no order, no charge', { skip }, async () => {
  const owner = await makeUser('owner');
  const { a, b, season } = await festivalWithSeason(owner);
  await query("UPDATE shows SET status='DRAFT' WHERE id=$1", [b.showId]);
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  const listed = (await catalogue.publicProducts(festival.id)).find((p) => p.id === season.productId);
  assert.equal(listed?.state, 'CLOSED');
  assert.equal(listed?.available, 0);
  assert.equal((await catalogue.publicProducts(festival.id)).find((p) => p.id === a.productId)?.state, 'SELLABLE', 'daily tickets for the published show still sell');

  const user = await makeUser();
  const error = await checkout.createCheckout(user, [
    { productId: a.productId, quantity: 1, version: 1 },
    { productId: season.productId, quantity: 1, version: 1 },
  ], randomUUID()).catch((e) => e);
  assert.match(String(error.message), /Sales for this performance have closed/);
  assert.equal(error.productId, season.productId, 'the server names the line to remove');
  assert.equal((await query('SELECT count(*)::int n FROM checkouts'))[0].n, 0);
  assert.equal((await query('SELECT count(*)::int n FROM bookings'))[0].n, 0, 'nothing held for any line');
  assert.equal(fake.count('POST /orders'), 0, 'no Razorpay order');
});

test('availability: catalogue and hold agree — SOLD_OUT when the online allocation is used up', { skip }, async () => {
  const owner = await makeUser('owner');
  const { a, b, season } = await festivalWithSeason(owner);
  for (const s of [a, b]) await inventory.configureCapacity(owner, await capacityOf(s.showId), { ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 1 });
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  assert.equal((await catalogue.publicProducts(festival.id)).find((p) => p.id === season.productId)?.state, 'SELLABLE');
  const u = await makeUser();
  await pay(u, (await reserve(u, season.productId)).id);
  assert.equal((await catalogue.publicProducts(festival.id)).find((p) => p.id === season.productId)?.state, 'SOLD_OUT');
  await assert.rejects(reserve(await makeUser(), season.productId), /Not enough tickets remain/);
});

// ---- HOLD LIFECYCLE -------------------------------------------------------------------------------

test('hold: last ticket — A holds, B is refused; A’s failed payment then expiry releases it; B buys; paid stays sold', { skip }, async () => {
  const show = await makeShow({ allocation: 1 });
  const [userA, userB] = [await makeUser(), await makeUser()];
  const [ra, rb] = await Promise.allSettled([reserve(userA, show.productId), reserve(userB, show.productId)]);
  const winner = ra.status === 'fulfilled' ? { user: userA, other: userB, hold: ra.value } : { user: userB, other: userA, hold: (rb as PromiseFulfilledResult<{ id: string }>).value };
  assert.equal([ra, rb].filter((r) => r.status === 'fulfilled').length, 1, 'exactly one hold');
  await pay(winner.user, winner.hold.id, 'failed'); // declined / cancelled: nothing captured
  await assert.rejects(reserve(winner.other, show.productId), /Not enough tickets remain/, 'still held until the hold ends');
  await expireNow(winner.hold.id);
  await commerce.expireHolds();
  const second = await reserve(winner.other, show.productId);
  await pay(winner.other, second.id);
  const p = (await query<{ held: number; committed: number }>('SELECT held, committed FROM pools WHERE id=$1', [show.poolId]))[0];
  assert.deepEqual(p, { held: 0, committed: 1 });
  await assert.rejects(reserve(await makeUser(), show.productId), /Not enough tickets remain/, 'a paid ticket stays sold');
});

// ---- SCANNER LOG + METRICS --------------------------------------------------------------------------

test('scanner: every scan is logged (show, gate, device, ticket, outcome, code) and metrics count them', { skip }, async () => {
  const show = await makeShow({ startsInMinutes: 30 });
  const other = await makeShow({ startsInMinutes: 30 });
  const buyer = await makeUser();
  const hold = await reserve(buyer, show.productId);
  await pay(buyer, hold.id);
  const scanner = await makeUser('scanner');
  await query(`INSERT INTO devices(id,name) VALUES('gate-one','Main') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO staff_scopes(user_id,show_id,gate,device_id) VALUES($1,$2,'gate-one','gate-one'),($1,$3,'gate-one','gate-one')`, [scanner.id, show.showId, other.showId]);
  const { decrypt } = await import('../src/lib/security');
  const token = decrypt((await query<{ encrypted_token: string }>(
    "SELECT c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id WHERE t.booking_id=$1 AND c.status='ACTIVE'", [hold.id]))[0].encrypted_token);
  const scan = (ticketToken: string, showId = show.showId) => admission.admit(scanner, { requestId: randomUUID(), ticketToken, showId, gateId: 'gate-one', deviceId: 'gate-one' });
  assert.equal((await scan(token)).result, 'ADMITTED');
  assert.equal((await scan(token)).result, 'DENIED');
  assert.equal((await scan(token, other.showId)).result, 'DENIED');
  assert.equal((await scan('forged-token')).result, 'UNKNOWN');
  const log = await query<{ code: string; outcome: string; gate: string; ticket_id: string | null; show_id: string }>('SELECT code, outcome, gate, ticket_id, show_id FROM scan_requests ORDER BY created_at');
  assert.deepEqual(log.map((r) => r.code), ['ADMITTED', 'DUPLICATE', 'WRONG_SHOW', 'UNKNOWN_CREDENTIAL']);
  assert.ok(log.slice(0, 3).every((r) => r.ticket_id && r.gate === 'gate-one'));
  const m = await metrics.adminMetrics({ showId: show.showId });
  assert.deepEqual([m.admission.total, m.admission.admitted, m.admission.duplicates, m.admission.rejected], [3, 1, 1, 2]);
  assert.equal(m.admission.byScanner[0].scannerId, scanner.id);
  assert.equal(m.sales.ticketsSold, 1);
  assert.equal(m.sales.confirmedRevenue, show.price);
  assert.equal(m.payments.byState.find((s) => s.state === 'CAPTURED')?.amount, show.price);
  await assert.rejects(metrics.adminMetrics({ showId: 'not-a-uuid' }), /Invalid show/);
});

// ---- STAFF MANAGEMENT -------------------------------------------------------------------------------

test('staff: owner creates a scanner (hashed password, all upcoming shows on every gate), resets password, deactivates', { skip }, async () => {
  await makeShow();
  const owner = await makeUser('owner');
  const created = await staff.upsertStaff({ contact: 'gate1@tickets.test', role: 'scanner', name: 'Gate One', password: 'correct horse battery' }, owner.id);
  assert.ok(created.scopesGranted >= 2, 'scoped for every gate');
  const row = (await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [created.id]))[0];
  assert.ok(row.password_hash && !row.password_hash.includes('correct horse'), 'only a hash is stored');
  const listed = (await staff.listStaff()).find((s) => s.id === created.id)!;
  assert.deepEqual([listed.role, listed.password], ['scanner', true]);
  assert.equal(Object.keys(listed).includes('password_hash'), false, 'the listing never exposes the hash');
  await query("INSERT INTO sessions(digest,user_id,expires_at) VALUES('d1',$1,now()+interval '1 hour')", [created.id]);
  await staff.setStaffPassword('gate1@tickets.test', 'another long password', owner.id);
  assert.equal((await query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [created.id]))[0].n, 0, 'password reset signs out');
  await assert.rejects(staff.setStaffPassword('gate1@tickets.test', 'short', owner.id), /12 characters/);
  await staff.revokeStaff('gate1@tickets.test', 'left the team', owner.id);
  const after = (await query<{ role: string; password_hash: string | null }>('SELECT role, password_hash FROM users WHERE id=$1', [created.id]))[0];
  assert.deepEqual(after, { role: 'customer', password_hash: null });
  assert.equal((await query("SELECT actor_id FROM audit_events WHERE action='staff.revoke'"))[0].actor_id, owner.id, 'the acting owner is audited');
  const revoked = { ...owner, role: 'customer' as const };
  await assert.rejects(admission.admit(revoked, { requestId: randomUUID(), ticketToken: 'x', showId: randomUUID(), gateId: 'gate-one', deviceId: 'gate-one' }), /permission/);
  assert.throws(() => auth.assertRole({ ...owner, role: 'scanner' }, ['owner', 'inventory']), /permission/, 'a scanner cannot use admin functions');
});

// ---- NOTIFICATION MATRIX (verified contacts; mobile is required to buy) -----------------------------

async function paidCart(user: User) {
  const a = await makeShow({ price: 50000 });
  const b = await makeShow({ price: 25000 });
  const lines = [{ productId: a.productId, quantity: 1, version: 1 }, { productId: b.productId, quantity: 2, version: 1 }];
  const co = await checkout.createCheckout(user, lines, randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return { a, b, co, order, payment: p };
}

/** Two ticks: the DELIVERY job sends the email and queues the SMS job, the next tick sends the SMS. */
async function deliver() {
  await jobs.processJobs();
  await query("UPDATE jobs SET run_at=now() WHERE state='PENDING'");
  await jobs.processJobs();
}
const emailsTo = (to: string) => fake.emails.filter((e) => e.to === to).length;
const smsTo = (mobile: string) => fake.sms.filter((s) => '+' + s.to === mobile).length;

test('notify matrix: mobile only → exactly one SMS (configured template + order reference), no email', { skip }, async () => {
  const user = await makeUser('customer', '+919876543210');
  const { co } = await paidCart(user);
  assert.deepEqual([fake.emails.length, fake.sms.length], [0, 0], 'nothing is sent inside the payment request');
  await deliver();
  assert.equal(fake.emails.length, 0);
  assert.equal(smsTo('+919876543210'), 1);
  assert.deepEqual([fake.sms[0].templateId, fake.sms[0].variables.REFERENCE, fake.sms[0].variables.LINK.endsWith('/tickets')], ['tmpl-confirm', co.reference, true]);
});

test('notify matrix: email + mobile → exactly one consolidated email AND one SMS', { skip }, async () => {
  const user = await makeUser('customer', undefined, { mobile: '+919800000002' });
  const { co } = await paidCart(user);
  await deliver();
  assert.equal(emailsTo(user.contact), 1);
  assert.equal(smsTo('+919800000002'), 1);
  const mail = fake.emails[0];
  assert.equal(mail.idempotencyKey, `checkout:${co.id}`, 'provider idempotency key = job key');
  for (const expected of ['Please collect your physical tickets before the show.', 'Zone: Premier', 'Quantity: 2', '/tickets', `/receipts/${co.id}`, co.reference]) {
    assert.ok(mail.text.includes(expected), `email mentions ${expected}`);
  }
  const keys = (await query<{ key: string; channel: string }>('SELECT key, channel FROM notification_deliveries ORDER BY channel')).map((r) => [r.channel, r.key]);
  assert.deepEqual(keys, [['email', `checkout:${co.id}`], ['sms', `sms:checkout:${co.id}`]], 'each delivery recorded once');
});

test('notify matrix: email only and no verified contact → purchase blocked before any hold or payment order', { skip }, async () => {
  const show = await makeShow();
  const emailOnly = await makeUser('customer', undefined, { mobile: null });
  for (const attempt of [
    () => checkout.createCheckout(emailOnly, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID()),
    () => commerce.reserve(emailOnly, { productId: show.productId, quantity: 1, version: 1 }, randomUUID()),
  ]) {
    const error = await attempt().catch((e) => e);
    assert.equal(error.code, 'MOBILE_REQUIRED');
    assert.equal(error.status, 409);
  }
  const { assertCanPurchase } = await import('../src/lib/account-contacts');
  await assert.rejects(assertCanPurchase(randomUUID()), /verify your mobile/, 'no account/contact at all is blocked too');
  assert.equal((await query('SELECT count(*)::int n FROM bookings'))[0].n, 0);
  assert.equal((await query('SELECT count(*)::int n FROM checkouts'))[0].n, 0);
  assert.equal(fake.count('POST /orders'), 0);
});

test('notify matrix: mobile only + SMS provider failure → booking stays CONFIRMED, SMS retried on its own, then sent once', { skip }, async () => {
  const user = await makeUser('customer', '+919800000003');
  const { co } = await paidCart(user);
  fake.failSms = true;
  await deliver();
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
  assert.equal((await query("SELECT count(*)::int n FROM payments WHERE state='CAPTURED'"))[0].n, 1, 'payment untouched');
  assert.equal((await query("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND t.status='ACTIVE'", [co.id]))[0].n, 3, 'tickets valid');
  assert.equal((await query('SELECT count(*)::int n FROM refunds'))[0].n, 0, 'never refunded');
  const smsJob = (await query<{ state: string; last_error: string | null }>("SELECT state, last_error FROM jobs WHERE kind='NOTIFY'"))[0];
  assert.equal(smsJob.state, 'PENDING');
  assert.match(String(smsJob.last_error), /SMS delivery/);
  fake.failSms = false;
  await deliver();
  assert.equal(smsTo('+919800000003'), 1);
});

test('notify matrix: email + mobile — SMS failure does not stop the email; email failure does not stop the SMS; each retries alone', { skip }, async () => {
  const smsDown = await makeUser('customer', undefined, { mobile: '+919800000004' });
  const emailDown = await makeUser('customer', undefined, { mobile: '+919800000005' });
  await paidCart(smsDown);
  fake.failSms = true;
  await deliver();
  assert.equal(emailsTo(smsDown.contact), 1, 'email sent while SMS is failing');
  assert.equal(smsTo('+919800000004'), 0);
  fake.failSms = false;
  await deliver();
  assert.deepEqual([emailsTo(smsDown.contact), smsTo('+919800000004')], [1, 1]);

  await paidCart(emailDown);
  fake.failEmail = true;
  await deliver();
  assert.equal(smsTo('+919800000005'), 1, 'SMS sent while email is failing');
  assert.equal(emailsTo(emailDown.contact), 0);
  fake.failEmail = false;
  await deliver();
  assert.deepEqual([emailsTo(emailDown.contact), smsTo('+919800000005')], [1, 1]);
});

test('notify matrix: webhook redelivery, reconciliation and job retry after delivery never duplicate email or SMS', { skip }, async () => {
  const user = await makeUser('customer', undefined, { mobile: '+919800000006' });
  const { co, payment } = await paidCart(user);
  await deliver();
  assert.deepEqual([emailsTo(user.contact), smsTo('+919800000006')], [1, 1]);
  // Webhook redelivered after the confirmation went out.
  const hook = webhook('payment.captured', payment);
  await payments.ingestRazorpayWebhook(hook.body, hook.signature);
  await payments.ingestRazorpayWebhook(hook.body, hook.signature);
  // Reconciliation finds the same captured payment again.
  await query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE checkout_id=$1', [co.id]);
  await payments.reconcileOpenRazorpayPayments();
  // A job whose send succeeded but whose DONE update was lost runs again.
  await query("UPDATE jobs SET state='PENDING', run_at=now() WHERE kind IN ('DELIVERY','NOTIFY')");
  await deliver();
  assert.deepEqual([emailsTo(user.contact), smsTo('+919800000006')], [1, 1], 'still exactly one of each');
});

test('notify matrix: browser closed after paying → reconciliation confirms → one email + one SMS, no duplicates later', { skip }, async () => {
  const user = await makeUser('customer', undefined, { mobile: '+919800000007' });
  const show = await makeShow();
  const co = await checkout.createCheckout(user, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  fake.pay(order.orderId); // no callback, no webhook
  await query('UPDATE payment_attempts SET next_reconcile_at=now() WHERE checkout_id=$1', [co.id]);
  await deliver();
  await deliver();
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
  assert.deepEqual([emailsTo(user.contact), smsTo('+919800000007')], [1, 1]);
});

test('notify: nothing is announced for an unpaid checkout', { skip }, async () => {
  const user = await makeUser();
  const show = await makeShow();
  const co = await checkout.createCheckout(user, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  const { deliverConfirmation, sendSmsConfirmation } = await import('../src/lib/notify');
  await deliverConfirmation({ checkoutId: co.id }, `checkout:${co.id}`);
  await sendSmsConfirmation({ checkoutId: co.id }, `sms:checkout:${co.id}`);
  assert.deepEqual([fake.emails.length, fake.sms.length], [0, 0]);
});

test('mobile verification: the number is stored only after its SMS code is proven; taken numbers and emails are refused', { skip }, async () => {
  const { verifyMobile, requestMobileVerification, verifiedContacts } = await import('../src/lib/account-contacts');
  const { keyedHash } = await import('../src/lib/security');
  const user = await makeUser('customer', undefined, { mobile: null });
  await makeUser('customer', '+919811112222');
  await assert.rejects(requestMobileVerification(user.id, '+91 98111 12222', '127.0.0.1'), /another account/);
  await assert.rejects(requestMobileVerification(user.id, 'someone@example.com', '127.0.0.1'), /mobile number/);
  // The OTP challenge the code was sent for (requestOtp creates exactly this row).
  const challenge = (await query<{ id: string }>(
    "INSERT INTO otp_challenges(contact,digest,expires_at) VALUES('+919833334444',$1,now()+interval '5 minutes') RETURNING id", [keyedHash('+919833334444:123456')]))[0];
  await assert.rejects(verifyMobile(user.id, challenge.id, '000000'), /incorrect/);
  assert.equal((await verifiedContacts(user.id)).mobile, null, 'nothing stored before the code is proven');
  await verifyMobile(user.id, challenge.id, '123456');
  assert.deepEqual(await verifiedContacts(user.id), { email: user.contact, mobile: '+919833334444' });
  await assert.rejects(verifyMobile(user.id, challenge.id, '123456'), /expired|no longer valid/, 'a code works once');
});

// ---- RECEIPT LINE STATUS ---------------------------------------------------------------------------

test('receipt: one line’s show cancelled → PARTIALLY_CANCELLED; that line refunded, the other line valid; the cart treats it as paid', { skip }, async () => {
  const user = await makeUser();
  const { a, co } = await paidCart(user);
  await catalogue.updateShow(await makeUser('owner'), a.showId, { status: 'CANCELLED', confirmCancellation: true });
  const receipt = await checkout.checkoutReceipt(user.id, co.id);
  assert.equal(receipt.status, 'PARTIALLY_CANCELLED');
  const lineA = receipt.lines.find((l) => l.quantity === 1)!; // show A, 1 ticket
  const lineB = receipt.lines.find((l) => l.quantity === 2)!; // show B, 2 tickets
  assert.deepEqual([lineA.status, lineB.status], ['CANCELLED', 'CONFIRMED']);
  assert.deepEqual(receipt.refunds.map((r) => [r.bookingId, r.amount]), [[lineA.bookingId, a.price]], 'only the cancelled line is refunded');
  const { outcomeOf } = await import('../src/lib/cart-reconcile');
  assert.equal(outcomeOf(receipt.status), 'paid');
});

test('receipt: an all-or-nothing refund ends as REFUNDED (not "refund required" forever)', { skip }, async () => {
  const user = await makeUser();
  const a = await makeShow({ allocation: 1 });
  const co = await checkout.createCheckout(user, [{ productId: a.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  await query("UPDATE bookings SET expires_at=now()-interval '1 second' WHERE checkout_id=$1", [co.id]);
  await commerce.expireHolds();
  const rival = await makeUser();
  await pay(rival, (await reserve(rival, a.productId)).id); // the seat is gone
  const p = fake.pay(order.orderId); // late payment for the expired cart
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user).catch(() => undefined);
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'REFUND_REQUIRED');
  await jobs.processJobs();
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'REFUNDED');
});
