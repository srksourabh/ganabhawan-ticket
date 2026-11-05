/**
 * All Together — Every Play programme inclusion (programme-inclusion.ts) and the explicit
 * entitlement amendment of existing passes, through the real catalogue, admin, checkout,
 * payment, job and ticket code on the local test database. Razorpay / Resend are the fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let inclusion: typeof import('../src/lib/programme-inclusion');
let pricing: typeof import('../src/lib/pricing');
let catalogue: typeof import('../src/lib/catalogue');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let commerce: typeof import('../src/lib/commerce');
let jobs: typeof import('../src/lib/jobs');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  inclusion = await import('../src/lib/programme-inclusion');
  pricing = await import('../src/lib/pricing');
  catalogue = await import('../src/lib/catalogue');
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  commerce = await import('../src/lib/commerce');
  jobs = await import('../src/lib/jobs');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  fake.reset();
  process.env.ALLOW_PUBLIC_SALES = 'true';
  process.env.SEASON_TICKET_SALES_ENABLED = 'true';
  await resetDatabase();
});

type Zone = 'Premier' | 'Superior' | 'Balcony';
const ZONES: Zone[] = ['Premier', 'Superior', 'Balcony'];
const BASE: Record<Zone, number> = { Premier: 50000, Superior: 35000, Balcony: 25000 };
const FINAL: Record<Zone, number> = { Premier: 400000, Superior: 300000, Balcony: 220000 };

/** A programme with all three zones (daily on sale, All Together seats in each). */
async function programme(startsInDays: number, title?: string) {
  const show = await makeShow({ startsInMinutes: startsInDays * 24 * 60, price: BASE.Premier, allocation: 20, title });
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  const daily: Record<Zone, string> = { Premier: show.productId, Superior: '', Balcony: '' };
  for (const zone of ['Superior', 'Balcony'] as Zone[]) {
    const cap = (await query<{ id: string }>('INSERT INTO capacities(show_id,zone,ceiling) VALUES($1,$2,500) RETURNING id', [show.showId, zone]))[0];
    const pool = (await query<{ id: string }>("INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'DAILY',20,1,10) RETURNING id", [cap.id]))[0];
    await query("INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'SEASON',50,11,12)", [cap.id]);
    daily[zone] = (await query<{ id: string }>(
      "INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id) VALUES($1,$2,$2,$3,'DAILY',$4,$5) RETURNING id",
      [festival.id, `Play – ${zone}`, zone, BASE[zone], show.showId]))[0].id;
    await query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [daily[zone], show.showId, pool.id]);
  }
  return { showId: show.showId, daily };
}
const seasonPool = async (showId: string, zone: Zone) => (await query<{ id: string; committed: number; held: number }>(
  "SELECT p.id, p.committed, p.held FROM pools p JOIN capacities c ON c.id=p.capacity_id WHERE c.show_id=$1 AND c.zone=$2 AND p.kind='SEASON'", [showId, zone]))[0];

/** N programmes, an All Together pass per zone covering all of them, shared prices configured. */
async function festival(n: number) {
  const shows = [];
  for (let i = 0; i < n; i++) shows.push(await programme(3 + i));
  const festivalId = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0].id;
  const passes = {} as Record<Zone, string>;
  for (const zone of ZONES) {
    passes[zone] = (await query<{ id: string }>(
      "INSERT INTO products(festival_id,name,name_bn,category,kind,price) VALUES($1,$2,$3,$4,'SEASON',$5) RETURNING id",
      [festivalId, `${zone} Season`, 'সিজন', zone, FINAL[zone]]))[0].id;
    for (const s of shows) await query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [passes[zone], s.showId, (await seasonPool(s.showId, zone)).id]);
    await query('INSERT INTO zone_prices(festival_id,zone,price) VALUES($1,$2,$3)', [festivalId, zone, BASE[zone]]);
  }
  return { festivalId, shows, passes };
}
const version = async (id: string) => Number((await query<{ version: number }>('SELECT version FROM products WHERE id=$1', [id]))[0].version);
const overviewRow = async (owner: User, zone: Zone) => (await pricing.pricingOverview(owner)).allTogether.find((r) => r.zone === zone)!;

async function buy(user: User, productId: string, quantity = 1) {
  const co = await checkout.createCheckout(user, [{ productId, quantity, version: await version(productId) }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return (await query<{ id: string }>('SELECT id FROM bookings WHERE checkout_id=$1', [co.id]))[0].id;
}

// ---- INCLUSION -----------------------------------------------------------------------------------

test('a new programme is excluded by default; ticking "Include" adds it to every zone of All Together', { skip }, async () => {
  const { passes } = await festival(3);
  const owner = await makeUser('owner');
  const input = { title: 'New play', titleBn: 'নতুন', troupe: 'T', synopsis: 'S', synopsisBn: 'S', runtime: 90, genre: 'Drama', status: 'PUBLISHED' };
  const plain = await catalogue.upsertShow(owner, { ...input, startsAt: new Date(Date.now() + 30 * 864e5).toISOString() });
  const ticked = await catalogue.upsertShow(owner, { ...input, title: 'Included play', startsAt: new Date(Date.now() + 31 * 864e5).toISOString(), allTogether: true });
  const states = await inclusion.inclusionStates();
  assert.equal(states.get(plain.id), 'EXCLUDED');
  assert.equal(states.get(ticked.id), 'INCLUDED');
  const listed = (await catalogue.adminCatalogue()).shows as { id: string; all_together: string }[];
  assert.equal(listed.find((s) => s.id === plain.id)!.all_together, 'EXCLUDED');
  for (const zone of ZONES) {
    const row = await overviewRow(owner, zone);
    assert.equal(row.programmeCount, 4, zone);
    assert.equal(row.originalTotal, BASE[zone] * 4);
    assert.deepEqual(row.missingProgrammes!.map((p) => p.id), [plain.id]);
    assert.equal(await version(passes[zone]), 2, 'carts holding the old pass must refresh');
  }
});

test('include and exclude later: count, original total, discount and % follow; the final price stays; invalid stops new passes', { skip }, async () => {
  const { shows, passes } = await festival(12);
  const owner = await makeUser('owner');
  const extra = await programme(40);
  await inclusion.setProgrammeInclusion(owner, extra.showId, true);
  let row = await overviewRow(owner, 'Premier');
  assert.deepEqual([row.programmeCount, row.originalTotal, row.finalPrice, row.discountAmount, row.discountPercent], [13, 650000, 400000, 250000, 38.46]);
  await inclusion.setProgrammeInclusion(owner, extra.showId, false);
  row = await overviewRow(owner, 'Premier');
  assert.deepEqual([row.programmeCount, row.originalTotal, row.discountAmount, row.discountPercent], [12, 600000, 200000, 33.33]);
  // Excluding down to 8 programmes: Balcony 8 × ₹250 = ₹2,000 < ₹2,200 final → flagged, not sold.
  for (const s of shows.slice(8)) await inclusion.setProgrammeInclusion(owner, s.showId, false);
  const balcony = await overviewRow(owner, 'Balcony');
  assert.deepEqual([balcony.programmeCount, balcony.blocked], [8, true]);
  await assert.rejects(checkout.createCheckout(await makeUser(), [{ productId: passes.Balcony, quantity: 1, version: await version(passes.Balcony) }], randomUUID()),
    (e: Error & { code?: string }) => e.code === 'SEASON_PRICE_INVALID');
  assert.equal((await overviewRow(owner, 'Premier')).blocked, false, 'zones are independent');
});

test('inclusion rules: cancelled or ended programmes cannot be included, the last one cannot be excluded, staff roles only', { skip }, async () => {
  const { shows } = await festival(1);
  const owner = await makeUser('owner');
  const cancelled = await programme(9);
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [cancelled.showId]);
  await assert.rejects(inclusion.setProgrammeInclusion(owner, cancelled.showId, true), /cancelled programme/);
  const ended = await programme(10);
  await query("UPDATE shows SET starts_at=now()-interval '3 hours', ends_at=now()-interval '1 hour' WHERE id=$1", [ended.showId]);
  await assert.rejects(inclusion.setProgrammeInclusion(owner, ended.showId, true), /has ended/);
  await assert.rejects(inclusion.setProgrammeInclusion(owner, shows[0].showId, false), /at least one programme/);
  await assert.rejects(inclusion.setProgrammeInclusion(owner, shows[0].showId, 'yes'), (e: Error & { status?: number }) => e.status === 400);
  for (const role of ['finance', 'desk', 'scanner', 'customer'] as const) {
    await assert.rejects(inclusion.setProgrammeInclusion(await makeUser(role), cancelled.showId, true), (e: Error & { status?: number }) => e.status === 403, role);
  }
  const audit = await query("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'programme.all_together.%'");
  assert.equal(audit[0].n, 0, 'refused changes leave no record');
});

test('a new pass stores exactly the programmes included at purchase (ids, names, dates, count, prices); later changes never alter it', { skip }, async () => {
  const { shows, passes } = await festival(12);
  const owner = await makeUser('owner');
  const bookingId = await buy(await makeUser(), passes.Superior);
  const row = async () => (await query<{ snapshot: { coverage: { showId: string; title: string; startsAt: string }[]; pricing: Record<string, number> }; total: number }>(
    'SELECT snapshot, total FROM bookings WHERE id=$1', [bookingId]))[0];
  const bought = await row();
  assert.deepEqual(bought.snapshot.coverage.map((c) => c.showId), shows.map((s) => s.showId), 'programme ids in date order');
  assert.ok(bought.snapshot.coverage.every((c) => c.title && c.startsAt));
  assert.deepEqual([bought.snapshot.pricing.programmeCount, bought.snapshot.pricing.originalTotal, bought.snapshot.pricing.discountAmount, bought.snapshot.pricing.finalPrice],
    [12, 420000, 120000, 300000]);
  await inclusion.setProgrammeInclusion(owner, shows[3].showId, false);
  await inclusion.setProgrammeInclusion(owner, (await programme(50)).showId, true);
  assert.deepEqual(await row(), bought);
  const ents = await query('SELECT count(*)::int n FROM entitlements e JOIN tickets t ON t.id=e.ticket_id WHERE t.booking_id=$1', [bookingId]);
  assert.equal(ents[0].n, 12, 'tickets still admit to the 12 programmes bought');
});

// ---- AMENDMENT OF EXISTING PASSES ---------------------------------------------------------------------

test('existing pass holders get the added programme by an explicit, audited, idempotent amendment; nothing else changes', { skip }, async () => {
  const { shows, passes } = await festival(11);
  const premierHolder = await makeUser();
  const superiorHolder = await makeUser();
  const premierBooking = await buy(premierHolder, passes.Premier);
  const superiorBooking = await buy(superiorHolder, passes.Superior, 2);
  const dailyBooking = await buy(await makeUser(), shows[0].daily.Balcony);
  // An expired pass hold must not be amended.
  const expired = await checkout.createCheckout(await makeUser(), [{ productId: passes.Balcony, quantity: 1, version: 1 }], randomUUID());
  await query("UPDATE bookings SET expires_at=now()-interval '1 minute' WHERE checkout_id=$1", [expired.id]);
  await commerce.expireHolds();

  const macbeth = await programme(1, 'Macbeth 2.0'); // created after the passes were sold
  const snapshotOf = async () => query('SELECT id, status, total, unit_price, quantity, snapshot, product_version FROM bookings ORDER BY id');
  const paymentsOf = async () => query('SELECT * FROM payments ORDER BY id');
  const attemptsOf = async () => query('SELECT id, state FROM payment_attempts ORDER BY id');
  const bookingsBefore = await snapshotOf();
  const paymentsBefore = await paymentsOf();
  const attemptsBefore = await attemptsOf();
  const ordersBefore = fake.orders.size;

  // Dry run: computed, then rolled back.
  const dry = await inclusion.amendExistingPasses({ id: null, label: 'test' }, macbeth.showId, { reason: 'Macbeth 2.0 added to every pass', notify: true, include: true, dryRun: true });
  assert.deepEqual([dry.included, dry.amended.length], [true, 2]);
  assert.equal((await inclusion.inclusionStates()).get(macbeth.showId), 'EXCLUDED', 'dry run changed nothing');
  assert.equal((await query("SELECT count(*)::int n FROM jobs WHERE kind='NOTICE'"))[0].n, 0);

  const result = await inclusion.amendExistingPasses({ id: null, label: 'operator script' }, macbeth.showId, { reason: 'Macbeth 2.0 added to every pass', notify: true, include: true });
  assert.equal(result.included, true);
  assert.deepEqual(result.amended.map((a) => [a.bookingId, a.quantity, a.previousProgrammeCount, a.newProgrammeCount]).sort(),
    [[premierBooking, 1, 11, 12], [superiorBooking, 2, 11, 12]].sort());
  assert.deepEqual(result.amended.map((a) => a.customerId).sort(), [premierHolder.id, superiorHolder.id].sort());

  // Each ticket now admits to Macbeth; seats are committed in the zone's All Together pool.
  for (const [booking, zone, seats] of [[premierBooking, 'Premier', 1], [superiorBooking, 'Superior', 2]] as const) {
    const ents = await query<{ n: number }>("SELECT count(*)::int n FROM entitlements e JOIN tickets t ON t.id=e.ticket_id WHERE t.booking_id=$1 AND e.show_id=$2 AND e.status='ACTIVE'", [booking, macbeth.showId]);
    assert.equal(ents[0].n, seats);
    assert.equal(Number((await seasonPool(macbeth.showId, zone)).committed), seats, zone);
    const owned = (await commerce.ownedBookings(zone === 'Premier' ? premierHolder.id : superiorHolder.id, booking))[0] as { added_programmes: { showId: string; title: string }[] };
    assert.deepEqual(owned.added_programmes.map((p) => p.title), ['Macbeth 2.0'], 'the ticket page lists it');
  }
  assert.equal(Number((await seasonPool(macbeth.showId, 'Balcony')).committed), 0);
  // Historical records untouched; no payment of any kind.
  assert.deepEqual(await snapshotOf(), bookingsBefore.map((b) => b), 'every booking row (amounts, snapshots, versions) unchanged');
  assert.deepEqual(await paymentsOf(), paymentsBefore);
  assert.deepEqual(await attemptsOf(), attemptsBefore);
  assert.equal(fake.orders.size, ordersBefore, 'no Razorpay order');
  assert.equal((await query("SELECT count(*)::int n FROM entitlements e JOIN tickets t ON t.id=e.ticket_id WHERE t.booking_id=$1 AND e.show_id=$2", [dailyBooking, macbeth.showId]))[0].n, 0);

  // Audit trail with every required field.
  const audit = await query<{ actor_id: string | null; entity: string; detail: Record<string, unknown> }>("SELECT actor_id, entity, detail FROM audit_events WHERE action='booking.entitlement.amend' ORDER BY entity");
  assert.equal(audit.length, 2);
  for (const a of audit) {
    assert.equal(a.actor_id, null);
    for (const key of ['bookingId', 'customerId', 'showId', 'previousProgrammeCount', 'newProgrammeCount', 'amendedAt', 'reason', 'actor']) assert.ok(a.detail[key] !== undefined, key);
    assert.equal(a.detail.showId, macbeth.showId);
    assert.equal(a.detail.actor, 'operator script');
  }

  // One notice per holder, sent once even when the worker runs again; a second amendment run changes nothing.
  await jobs.processJobs();
  await jobs.processJobs();
  const notices = fake.emails.filter((e) => /now included in your All Together — Every Play pass/.test(e.text));
  assert.deepEqual(notices.map((e) => e.to).sort(), [premierHolder.contact, superiorHolder.contact].sort());
  const again = await inclusion.amendExistingPasses({ id: null, label: 'operator script' }, macbeth.showId, { reason: 'Macbeth 2.0 added to every pass', notify: true, include: true });
  assert.deepEqual([again.included, again.amended.length, again.skipped], [false, 0, 2]);
  await jobs.processJobs();
  assert.equal(fake.emails.filter((e) => /now included/.test(e.text)).length, 2, 'no duplicate notice');
  assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE action='booking.entitlement.amend'"))[0].n, 2);
  assert.equal(Number((await seasonPool(macbeth.showId, 'Superior')).committed), 2, 'seats not counted twice');

  // New passes now cover 12 programmes, Macbeth first.
  const newBooking = await buy(await makeUser(), passes.Premier);
  const snap = (await query<{ snapshot: { coverage: { title: string }[]; pricing: { programmeCount: number; originalTotal: number } } }>('SELECT snapshot FROM bookings WHERE id=$1', [newBooking]))[0].snapshot;
  assert.deepEqual([snap.coverage.length, snap.coverage[0].title, snap.pricing.programmeCount, snap.pricing.originalTotal], [12, 'Macbeth 2.0', 12, 600000]);
});

test('amendment refuses unsafe cases: programme not included, not published, or no seats left', { skip }, async () => {
  const { passes } = await festival(3);
  await query('UPDATE products SET price=100000 WHERE id=$1', [passes.Premier]); // valid for 3 programmes
  await buy(await makeUser(), passes.Premier);
  const late = await programme(1);
  await assert.rejects(inclusion.amendExistingPasses({ id: null, label: 't' }, late.showId, { reason: 'adding the late programme', notify: false }), /before amending/);
  await query("UPDATE pools SET allocation=0 FROM capacities c WHERE c.id=pools.capacity_id AND c.show_id=$1 AND pools.kind='SEASON'", [late.showId]);
  await assert.rejects(inclusion.amendExistingPasses({ id: null, label: 't' }, late.showId, { reason: 'adding the late programme', notify: false, include: true }),
    (e: Error & { code?: string }) => e.code === 'AMEND_NO_SEATS');
  assert.equal((await inclusion.inclusionStates()).get(late.showId), 'EXCLUDED', 'the whole transaction rolled back');
  await assert.rejects(inclusion.amendExistingPasses({ id: null, label: 't' }, late.showId, { reason: 'short', notify: false }), /reason/);
  const draft = await programme(2);
  await query("UPDATE shows SET status='DRAFT' WHERE id=$1", [draft.showId]);
  await assert.rejects(inclusion.amendExistingPasses({ id: null, label: 't' }, draft.showId, { reason: 'adding the draft programme', notify: false, include: true }), /published/);
});

// ---- TERMINOLOGY IN WHAT CUSTOMERS RECEIVE ---------------------------------------------------------------

test('cart, checkout, receipt and email name the pass "All Together — Every Play", never "Season"', { skip }, async () => {
  const { passes } = await festival(3);
  await query('UPDATE products SET price=60000 WHERE id=$1', [passes.Premier]); // valid for 3 programmes
  const user = await makeUser();
  const co = await checkout.createCheckout(user, [{ productId: passes.Premier, quantity: 1, version: 1 }], randomUUID());
  assert.equal(co.bookings[0].name, 'All Together — Every Play · Front block');
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  const receipt = await checkout.checkoutReceipt(user.id, co.id);
  assert.equal(receipt.lines[0].product, 'All Together — Every Play · Front block');
  assert.ok(!/season/i.test(checkout.receiptText(receipt, 'https://x.test')), 'receipt text');
  await jobs.processJobs();
  await jobs.processJobs();
  const mail = fake.emails.find((e) => e.to === user.contact)!;
  assert.ok(mail, 'confirmation sent');
  assert.match(mail.text, /All Together — Every Play · Front block/);
  assert.ok(!/season/i.test(mail.text), 'email text');
  assert.ok(!/\bseason\b/i.test(mail.html!.replace(/<[^>]+>/g, ' ')), 'email html (visible text)');
});

test('notices can be queued on a later run, once per amended pass, never for a pass that bought the programme', { skip }, async () => {
  const { passes } = await festival(11);
  const holder = await makeUser();
  await buy(holder, passes.Premier);
  const macbeth = await programme(1, 'Macbeth 2.0');
  const actor = { id: null, label: 'operator script' };
  const first = await inclusion.amendExistingPasses(actor, macbeth.showId, { reason: 'Macbeth 2.0 added to every pass', notify: false, include: true });
  assert.deepEqual([first.amended.length, first.noticesQueued], [1, 0]);
  // Someone buys the pass after Macbeth was included: it covers Macbeth from purchase, no notice for them.
  const later = await makeUser();
  await buy(later, passes.Premier);
  const second = await inclusion.amendExistingPasses(actor, macbeth.showId, { reason: 'Macbeth 2.0 added to every pass', notify: true });
  assert.deepEqual([second.amended.length, second.skipped, second.noticesQueued], [0, 2, 1]);
  const third = await inclusion.amendExistingPasses(actor, macbeth.showId, { reason: 'Macbeth 2.0 added to every pass', notify: true });
  assert.equal(third.noticesQueued, 0, 'never queued twice');
  await jobs.processJobs();
  const notices = fake.emails.filter((e) => /now included in your All Together/.test(e.text));
  assert.deepEqual(notices.map((e) => e.to), [holder.contact]);
});
