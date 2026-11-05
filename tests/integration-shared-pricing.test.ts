/**
 * Shared per-programme pricing and All together discounts (pricing.ts, migration 0012) through
 * the real catalogue, admin, cart, checkout and payment code on the local test database.
 * Razorpay is the in-process fake: the order amount it receives is asserted directly.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let pricing: typeof import('../src/lib/pricing');
let catalogue: typeof import('../src/lib/catalogue');
let seasons: typeof import('../src/lib/seasons');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  pricing = await import('../src/lib/pricing');
  catalogue = await import('../src/lib/catalogue');
  seasons = await import('../src/lib/seasons');
  checkout = await import('../src/lib/checkout');
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
  process.env.ALLOW_PUBLIC_SALES = 'true';
  process.env.SEASON_TICKET_SALES_ENABLED = 'true';
  await resetDatabase();
});

type Zone = 'Premier' | 'Superior' | 'Balcony';
const ZONES: Zone[] = ['Premier', 'Superior', 'Balcony'];
const BASE: Record<Zone, number> = { Premier: 50000, Superior: 35000, Balcony: 25000 };
const FINAL: Record<Zone, number> = { Premier: 400000, Superior: 300000, Balcony: 220000 };

/** A programme with all three zones on sale (daily) and season stock in each. */
async function programme(startsInDays: number) {
  const show = await makeShow({ startsInMinutes: startsInDays * 24 * 60, price: BASE.Premier, allocation: 20 });
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  const seasonPools: Record<Zone, string> = { Premier: show.seasonPoolId, Superior: '', Balcony: '' };
  const daily: Record<Zone, string> = { Premier: show.productId, Superior: '', Balcony: '' };
  for (const zone of ['Superior', 'Balcony'] as Zone[]) {
    const cap = (await query<{ id: string }>('INSERT INTO capacities(show_id,zone,ceiling) VALUES($1,$2,500) RETURNING id', [show.showId, zone]))[0];
    const pool = (await query<{ id: string }>("INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'DAILY',20,1,10) RETURNING id", [cap.id]))[0];
    seasonPools[zone] = (await query<{ id: string }>("INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'SEASON',50,11,12) RETURNING id", [cap.id]))[0].id;
    daily[zone] = (await query<{ id: string }>(
      "INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id) VALUES($1,$2,$2,$3,'DAILY',$4,$5) RETURNING id",
      [festival.id, `Play – ${zone}`, zone, BASE[zone], show.showId]))[0].id;
    await query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [daily[zone], show.showId, pool.id]);
  }
  return { showId: show.showId, seasonPools, daily };
}

/** N programmes, an All together pass per zone covering all of them, and the configured base prices. */
async function festival(n = 12, configure = true) {
  const shows = [];
  for (let i = 0; i < n; i++) shows.push(await programme(3 + i));
  const festivalId = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0].id;
  const passes = {} as Record<Zone, string>;
  for (const zone of ZONES) {
    passes[zone] = (await query<{ id: string }>(
      "INSERT INTO products(festival_id,name,name_bn,category,kind,price) VALUES($1,$2,$2,$3,'SEASON',$4) RETURNING id",
      [festivalId, `${zone} Season`, zone, FINAL[zone]]))[0].id;
    for (const s of shows) await query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [passes[zone], s.showId, s.seasonPools[zone]]);
  }
  if (configure) for (const zone of ZONES) await query('INSERT INTO zone_prices(festival_id,zone,price) VALUES($1,$2,$3)', [festivalId, zone, BASE[zone]]);
  return { festivalId, shows, passes };
}

async function publicView() {
  const festivalId = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0].id;
  return catalogue.publicProducts(festivalId);
}
const productIn = async (id: string) => (await publicView()).find((p) => p.id === id)!;
const version = async (id: string) => Number((await query<{ version: number }>('SELECT version FROM products WHERE id=$1', [id]))[0].version);

async function pay(user: User, lines: { productId: string; quantity: number; version: number }[]) {
  const co = await checkout.createCheckout(user, lines, randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return { co, order, amountSentToRazorpay: fake.orders.get(order.orderId)!.amount };
}

// ---- SHARED BASE PRICE ---------------------------------------------------------------------------------

test('catalogue: All together shows ₹price × N, the original total, saving and percentage per zone (programme count from the data)', { skip }, async () => {
  const { passes } = await festival(12);
  const expected: Record<Zone, [number, number, number]> = { Premier: [600000, 200000, 33.33], Superior: [420000, 120000, 28.57], Balcony: [300000, 80000, 26.67] };
  for (const zone of ZONES) {
    const p = await productIn(passes[zone]);
    assert.equal(p.state, 'SELLABLE');
    assert.equal(p.price, FINAL[zone], 'the price charged is the final price');
    assert.deepEqual([p.pricing!.perProgrammePrice, p.pricing!.programmeCount], [BASE[zone], 12]);
    assert.deepEqual([p.pricing!.originalTotal, p.pricing!.discountAmount, p.pricing!.discountPercent], expected[zone]);
  }
  // Individual programme tickets: the shared price, no discount breakdown at all.
  const daily = (await publicView()).filter((p) => p.kind === 'DAILY');
  assert.equal(daily.length, 36);
  for (const d of daily) {
    assert.equal(d.price, BASE[d.category as Zone]);
    assert.equal(d.pricing, undefined);
  }
});

for (const zone of ZONES) {
  test(`${zone}: changing the price per programme updates every daily ticket AND the All together original, saving and %`, { skip }, async () => {
    const { shows, passes } = await festival(12);
    const owner = await makeUser('owner');
    const next = BASE[zone] + 10000;
    const before = await version(shows[0].daily[zone]);
    const saved = await pricing.setZonePrice(owner, { zone, price: next, version: 1 });
    assert.equal(saved.dailyProductsUpdated, 12);
    for (const s of shows) assert.equal((await productIn(s.daily[zone])).price, next, 'individual programme price');
    assert.equal(await version(shows[0].daily[zone]), before + 1, 'carts holding the old price must refresh');
    // Other zones untouched.
    for (const other of ZONES.filter((z) => z !== zone)) assert.equal((await productIn(shows[0].daily[other])).price, BASE[other]);
    const pass = await productIn(passes[zone]);
    assert.equal(pass.price, FINAL[zone], 'final All together price unchanged');
    assert.equal(pass.pricing!.originalTotal, next * 12);
    assert.equal(pass.pricing!.discountAmount, next * 12 - FINAL[zone]);
    assert.equal(pass.pricing!.discountPercent, Math.round(((next * 12 - FINAL[zone]) / (next * 12)) * 10000) / 100);
    const overview = await pricing.pricingOverview(owner);
    const row = overview.zones.find((z) => z.zone === zone)!;
    assert.deepEqual([row.price, row.configured, row.version], [next, true, 2]);
    assert.ok(row.updatedAt);
  });
}

test('Front block ₹500 → ₹600 with 12 programmes: original ₹7,200; cancelling or adding a programme recalculates it', { skip }, async () => {
  const { shows, passes } = await festival(12);
  await pricing.setZonePrice(await makeUser('owner'), { zone: 'Premier', price: 60000 });
  assert.equal((await productIn(passes.Premier)).pricing!.originalTotal, 720000);
  // A cancelled programme is not part of a new sale: 11 programmes now.
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [shows[11].showId]);
  assert.deepEqual([(await productIn(passes.Premier)).pricing!.programmeCount, (await productIn(passes.Premier)).pricing!.originalTotal], [11, 660000]);
  const extra = await programme(30);
  await seasons.addSeasonPerformance(await makeUser('owner'), passes.Premier, extra.showId);
  assert.equal((await productIn(passes.Premier)).pricing!.originalTotal, 720000);
});

test('ended and cancelled programmes keep their price; inventory is untouched by a price change', { skip }, async () => {
  const { shows } = await festival(3);
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [shows[2].showId]);
  const poolsBefore = await query('SELECT id, allocation, held, committed FROM pools ORDER BY id');
  await pricing.setZonePrice(await makeUser('owner'), { zone: 'Balcony', price: 30000 });
  assert.equal(Number((await query<{ price: number }>('SELECT price FROM products WHERE id=$1', [shows[2].daily.Balcony]))[0].price), BASE.Balcony);
  assert.equal(Number((await query<{ price: number }>('SELECT price FROM products WHERE id=$1', [shows[0].daily.Balcony]))[0].price), 30000);
  assert.deepEqual(await query('SELECT id, allocation, held, committed FROM pools ORDER BY id'), poolsBefore);
});

test('a new programme takes the shared price; a different per-programme daily price is refused (one source)', { skip }, async () => {
  const { shows } = await festival(2);
  const owner = await makeUser('owner');
  await pricing.setZonePrice(owner, { zone: 'Superior', price: 40000 });
  const created = await catalogue.upsertShow(owner, {
    title: 'New play', titleBn: 'নতুন', troupe: 'T', synopsis: 'S', synopsisBn: 'S', startsAt: new Date(Date.now() + 40 * 864e5).toISOString(),
    runtime: 90, genre: 'Drama', status: 'PUBLISHED',
  });
  const prices = await query<{ category: Zone; price: number }>("SELECT category, price FROM products WHERE show_id=$1 AND kind='DAILY'", [created.id]);
  assert.deepEqual(Object.fromEntries(prices.map((r) => [r.category, Number(r.price)])), { Premier: BASE.Premier, Superior: 40000, Balcony: BASE.Balcony });
  const id = shows[0].daily.Superior;
  const v = await version(id);
  await assert.rejects(catalogue.updateProduct(owner, id, { price: 45000, version: v }), (e: Error & { code?: string }) => e.code === 'DAILY_PRICE_SHARED' && /Price per programme/.test(e.message));
  await assert.rejects(catalogue.updateShow(owner, shows[0].showId, { prices: { Superior: 45000 } }), (e: Error & { code?: string }) => e.code === 'DAILY_PRICE_SHARED');
  // Same price (name / On sale edits from the admin screen) still works.
  await catalogue.updateProduct(owner, id, { price: 40000, version: v, name: 'Renamed', enabled: true });
  assert.equal((await query<{ name: string }>('SELECT name FROM products WHERE id=$1', [id]))[0].name, 'Renamed');
});

test('price per programme: roles, validation and concurrent edits', { skip }, async () => {
  await festival(1);
  for (const role of ['finance', 'desk', 'scanner', 'supervisor', 'customer'] as const) {
    await assert.rejects(pricing.setZonePrice(await makeUser(role), { zone: 'Premier', price: 60000 }), (e: Error & { status?: number }) => e.status === 403, role);
    await assert.rejects(pricing.pricingOverview(await makeUser(role)), (e: Error & { status?: number }) => e.status === 403, role);
  }
  const inventory = await makeUser('inventory');
  for (const bad of [{ zone: 'Stage', price: 100 }, { zone: 'Premier', price: 0 }, { zone: 'Premier', price: -1 }, { zone: 'Premier', price: 1.5 }, { zone: 'Premier', price: '600' }]) {
    await assert.rejects(pricing.setZonePrice(inventory, bad), (e: Error & { status?: number }) => e.status === 400, JSON.stringify(bad));
  }
  await pricing.setZonePrice(inventory, { zone: 'Premier', price: 60000, version: 1 });
  await assert.rejects(pricing.setZonePrice(inventory, { zone: 'Premier', price: 70000, version: 1 }), (e: Error & { status?: number }) => e.status === 409);
  const audit = await query<{ detail: { before: number; after: number } }>("SELECT detail FROM audit_events WHERE action='pricing.zone.update'");
  assert.deepEqual([audit.length, audit[0].detail.before, audit[0].detail.after], [1, BASE.Premier, 60000]);
});

// ---- ALL TOGETHER FINAL PRICE -------------------------------------------------------------------------

test('admin sets each zone final price independently; above the original total is refused', { skip }, async () => {
  const { passes } = await festival(12);
  const owner = await makeUser('owner');
  await seasons.updateSeason(owner, passes.Superior, { price: 250000, version: 1 });
  assert.deepEqual([(await productIn(passes.Superior)).price, (await productIn(passes.Superior)).pricing!.discountAmount], [250000, 170000]);
  assert.equal((await productIn(passes.Premier)).price, FINAL.Premier, 'other zones unchanged');
  assert.equal((await productIn(passes.Balcony)).price, FINAL.Balcony);
  await assert.rejects(seasons.updateSeason(owner, passes.Balcony, { price: 300001, version: 1 }),
    (e: Error & { status?: number; code?: string }) => e.status === 400 && e.code === 'SEASON_PRICE_ABOVE_ORIGINAL' && /₹3,000/.test(e.message));
  await seasons.updateSeason(owner, passes.Balcony, { price: 300000, version: 1 }); // equal to the original: valid, no discount
  const equal = await productIn(passes.Balcony);
  assert.deepEqual([equal.state, equal.pricing!.discountAmount, equal.pricing!.showDiscount], ['SELLABLE', 0, false]);
  // The older product editor applies the same rule.
  await assert.rejects(catalogue.updateProduct(owner, passes.Premier, { price: 600001, version: 1 }), (e: Error & { code?: string }) => e.code === 'SEASON_PRICE_ABOVE_ORIGINAL');
  const overview = await pricing.pricingOverview(owner);
  const superior = overview.allTogether.find((r) => r.zone === 'Superior')!;
  assert.deepEqual([superior.originalTotal, superior.finalPrice, superior.discountAmount, superior.discountPercent], [420000, 250000, 170000, 40.48]);
  assert.ok(superior.updatedAt, 'last updated');
});

test('lowering the price per programme below the final price flags it and stops NEW All together sales until fixed', { skip }, async () => {
  const { passes, shows } = await festival(12);
  const owner = await makeUser('owner');
  const customer = await makeUser('customer');
  const held = await checkout.createCheckout(customer, [{ productId: passes.Balcony, quantity: 1, version: 1 }], randomUUID());
  await pricing.setZonePrice(owner, { zone: 'Balcony', price: 15000 }); // 12 × ₹150 = ₹1,800 < ₹2,200
  const flagged = await productIn(passes.Balcony);
  assert.deepEqual([flagged.state, flagged.available, flagged.pricing!.blocked], ['CLOSED', 0, true]);
  const row = (await pricing.pricingOverview(owner)).allTogether.find((r) => r.zone === 'Balcony')!;
  assert.equal(row.blocked, true);
  assert.match(row.problem!, /more than the original total/);
  await assert.rejects(checkout.createCheckout(await makeUser('customer'), [{ productId: passes.Balcony, quantity: 1, version: 1 }], randomUUID()),
    (e: Error & { code?: string }) => e.code === 'SEASON_PRICE_INVALID');
  // A hold made before the change is not charged above the new original either.
  await assert.rejects(checkout.createCheckoutPaymentOrder(customer, held.id), (e: Error & { code?: string }) => e.code === 'SEASON_PRICE_INVALID');
  assert.equal(fake.orders.size, 0, 'no Razorpay order was created');
  // Daily tickets keep selling at the new shared price.
  const daily = await pay(await makeUser('customer'), [{ productId: shows[0].daily.Balcony, quantity: 2, version: await version(shows[0].daily.Balcony) }]);
  assert.equal(daily.amountSentToRazorpay, 30000);
  // The admin lowers the final price: sales resume.
  await seasons.updateSeason(owner, passes.Balcony, { price: 160000, version: 1 });
  assert.equal((await productIn(passes.Balcony)).state, 'SELLABLE');
  const bought = await pay(await makeUser('customer'), [{ productId: passes.Balcony, quantity: 1, version: 2 }]);
  assert.equal(bought.amountSentToRazorpay, 160000);
});

// ---- PAYMENT, SNAPSHOT AND HISTORY ---------------------------------------------------------------------

test('Razorpay receives the server-computed amount; prices sent by the browser are ignored', { skip }, async () => {
  const { passes, shows } = await festival(12);
  const user = await makeUser('customer');
  const lines = [
    { productId: passes.Premier, quantity: 2, version: 1, price: 1, unitPrice: 1, total: 1, discount: 999999 },
    { productId: shows[0].daily.Superior, quantity: 3, version: 1, price: 1 },
  ];
  const { co, amountSentToRazorpay } = await pay(user, lines as never);
  assert.equal(amountSentToRazorpay, 2 * FINAL.Premier + 3 * BASE.Superior);
  const rows = await query<{ unit_price: number; total: number; status: string; snapshot: { pricing: Record<string, unknown> } }>(
    'SELECT unit_price, total, status, snapshot FROM bookings WHERE checkout_id=$1 ORDER BY total DESC', [co.id]);
  assert.deepEqual(rows.map((r) => [Number(r.unit_price), Number(r.total), r.status]), [[FINAL.Premier, 2 * FINAL.Premier, 'CONFIRMED'], [BASE.Superior, 3 * BASE.Superior, 'CONFIRMED']]);
  assert.deepEqual(rows[0].snapshot.pricing, {
    zone: 'Premier', zoneName: 'Front block', kind: 'SEASON', perProgrammePrice: 50000, programmeCount: 12,
    originalTotal: 600000, discountAmount: 200000, discountPercent: 33.33, finalPrice: 400000, pricingVersion: 1,
  });
  assert.deepEqual(rows[1].snapshot.pricing, {
    zone: 'Superior', zoneName: 'Second block', kind: 'DAILY', perProgrammePrice: 35000, programmeCount: 1,
    originalTotal: 35000, discountAmount: 0, discountPercent: 0, finalPrice: 35000, pricingVersion: 1,
  });
  // A stale version after a price change is refused (never silently re-priced).
  await pricing.setZonePrice(await makeUser('owner'), { zone: 'Superior', price: 36000 });
  await assert.rejects(checkout.createCheckout(user, [{ productId: shows[1].daily.Superior, quantity: 1, version: 1 }], randomUUID()), /price has changed/i);
});

test('historical bookings keep their amounts after prices change', { skip }, async () => {
  const { passes, shows } = await festival(12);
  const user = await makeUser('customer');
  const { co } = await pay(user, [{ productId: passes.Premier, quantity: 1, version: 1 }, { productId: shows[0].daily.Premier, quantity: 1, version: 1 }]);
  const snap = async () => query('SELECT id, unit_price, total, snapshot FROM bookings WHERE checkout_id=$1 ORDER BY id', [co.id]);
  const before = await snap();
  const owner = await makeUser('owner');
  await pricing.setZonePrice(owner, { zone: 'Premier', price: 60000 });
  await seasons.updateSeason(owner, passes.Premier, { price: 450000, version: 1 });
  assert.deepEqual(await snap(), before);
  const receipt = await checkout.checkoutReceipt(user.id, co.id);
  assert.equal(receipt.total, FINAL.Premier + BASE.Premier);
  assert.ok(receipt.lines.every((l) => !/Premier/.test(l.product)), 'receipt shows display names');
});

test('concurrent All together checkouts cannot oversell the last pass', { skip }, async () => {
  const { passes, shows } = await festival(3);
  await query('UPDATE products SET price=100000 WHERE id=$1', [passes.Superior]); // ₹1,000 ≤ 3 × ₹350
  await query('UPDATE pools SET allocation=1 WHERE id=$1', [shows[1].seasonPools.Superior]);
  const buyers = await Promise.all([makeUser('customer'), makeUser('customer'), makeUser('customer')]);
  const results = await Promise.allSettled(buyers.map((u) => checkout.createCheckout(u, [{ productId: passes.Superior, quantity: 1, version: 1 }], randomUUID())));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status === 'rejected' ? String(r.reason) : 'ok')));
  const pool = (await query<{ held: number; allocation: number }>('SELECT held, allocation FROM pools WHERE id=$1', [shows[1].seasonPools.Superior]))[0];
  assert.deepEqual([Number(pool.held), Number(pool.allocation)], [1, 1]);
});

// ---- MIGRATION AND BACKWARD COMPATIBILITY --------------------------------------------------------------

test('migration 0012 seeds each zone from the most common upcoming daily price; without rows nothing is enforced', { skip }, async () => {
  const { festivalId, shows, passes } = await festival(3, false);
  await query('UPDATE products SET price=99900 WHERE id=$1', [shows[0].daily.Premier]); // one odd price
  // No zone_prices rows: the price is derived (shown, never enforced).
  const derived = (await pricing.loadZonePrices(festivalId)).Premier;
  assert.deepEqual([derived.price, derived.configured], [BASE.Premier, false]);
  await query('UPDATE products SET price=999999 WHERE id=$1', [passes.Balcony]);
  assert.equal((await productIn(passes.Balcony)).state, 'SELLABLE', 'legacy (no configured price) behaviour unchanged');
  await query('UPDATE products SET price=$1 WHERE id=$2', [FINAL.Balcony, passes.Balcony]);
  const sql = readFileSync('db/migrations/0012_zone_prices.sql', 'utf8');
  await query(sql.slice(sql.indexOf('INSERT INTO zone_prices')));
  const seeded = await query<{ zone: Zone; price: number; version: number }>('SELECT zone, price, version FROM zone_prices ORDER BY zone');
  assert.deepEqual(seeded.map((r) => [r.zone, Number(r.price), Number(r.version)]), [['Balcony', BASE.Balcony, 1], ['Premier', BASE.Premier, 1], ['Superior', BASE.Superior, 1]]);
  assert.equal(Number((await query<{ price: number }>('SELECT price FROM products WHERE id=$1', [shows[0].daily.Premier]))[0].price), 99900, 'the migration changes no product');
});

// ---- PROGRAMME COVERAGE (production: 12 published programmes, passes cover 11) ---------------------------

test('a published programme outside the pass is reported, never counted or added silently; the count follows real coverage', { skip }, async () => {
  const { shows, passes } = await festival(11);
  // Created after the passes (as Macbeth 2.0 was in production): not part of them.
  const late = await programme(1);
  const owner = await makeUser('owner');
  const view = await pricing.pricingOverview(owner);
  for (const zone of ZONES) {
    const row = view.allTogether.find((r) => r.zone === zone)!;
    assert.equal(row.programmeCount, 11, zone);
    assert.equal(row.originalTotal, BASE[zone] * 11);
    assert.deepEqual(row.programmes!.map((p) => p.id), shows.map((s) => s.showId), 'covered programmes, in date order');
    assert.deepEqual(row.missingProgrammes!.map((p) => p.id), [late.showId], 'the uncovered published programme is named');
  }
  assert.equal((await productIn(passes.Premier)).pricing!.programmeCount, 11, 'the customer sees the same count');
  // A sold pass can still gain it for NEW purchases; the existing buyer's booking is unchanged.
  const { co } = await pay(await makeUser('customer'), [{ productId: passes.Premier, quantity: 1, version: 1 }]);
  const sold = async () => query('SELECT snapshot, total, unit_price FROM bookings WHERE checkout_id=$1', [co.id]);
  const was = await sold();
  await seasons.addSeasonPerformance(owner, passes.Premier, late.showId);
  assert.deepEqual(await sold(), was);
  assert.equal((await pricing.pricingOverview(owner)).allTogether.find((r) => r.zone === 'Premier')!.programmeCount, 12);
  // An unsold pass can take it: then 12 programmes, ₹350 × 12 = ₹4,200, nothing missing.
  await seasons.addSeasonPerformance(owner, passes.Superior, late.showId);
  const superior = (await pricing.pricingOverview(owner)).allTogether.find((r) => r.zone === 'Superior')!;
  assert.deepEqual([superior.programmeCount, superior.originalTotal, superior.missingProgrammes!.length], [12, 420000, 0]);
  assert.equal(superior.programmes![0].id, late.showId, 'date order: the earlier programme comes first');
  const product = await productIn(passes.Superior);
  assert.deepEqual([product.pricing!.programmeCount, product.pricing!.originalTotal, product.coverage.length], [12, 420000, 12]);
});
