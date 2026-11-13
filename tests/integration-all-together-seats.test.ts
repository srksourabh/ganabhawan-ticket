/**
 * Adding All Together (season) seats from the admin inventory screen (inventory-admin.ts
 * addAllTogetherSeats), on inventory shaped like production: 12 covered programmes with 10 online
 * All Together seats per zone, one Front block and one Second block pass sold (so 9 / 9 / 10 left),
 * and an uncovered DRAFT duplicate programme with a large daily allocation.
 *
 * The reported bug: daily seats could be added per performance, All Together seats could not.
 * A pass needs a seat in every programme, so its seats left are the LOWEST count among them;
 * editing one performance never changes it, and the only zone-wide form replaced numbers
 * (entering 1 dropped the pass to 0) and was refused because of a programme the pass does not cover.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let inv: typeof import('../src/lib/inventory-admin');
let seasons: typeof import('../src/lib/seasons');
let catalogue: typeof import('../src/lib/catalogue');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let q: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  inv = await import('../src/lib/inventory-admin');
  seasons = await import('../src/lib/seasons');
  catalogue = await import('../src/lib/catalogue');
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  ({ query: q } = await import('../src/lib/db'));
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
const CEIL: Record<Zone, number> = { Premier: 100, Superior: 120, Balcony: 80 };

/** A programme with all three zones: daily 10, All Together set aside 10 and sold online 10 (or a draft-like large daily). */
async function programme(days: number, opts: { status?: string; daily?: Partial<Record<Zone, number>>; season?: number } = {}) {
  const dailyOf = (zone: Zone) => opts.daily?.[zone] ?? 10;
  const daily = dailyOf('Premier');
  const season = opts.season ?? 10;
  const s = await makeShow({ startsInMinutes: days * 1440, allocation: daily });
  await q('UPDATE shows SET status=$1 WHERE id=$2', [opts.status ?? 'PUBLISHED', s.showId]);
  await q("UPDATE pools SET allocation=$2 FROM capacities c WHERE c.id=pools.capacity_id AND c.show_id=$1 AND pools.kind='SEASON'", [s.showId, season]);
  await q('UPDATE capacities SET ceiling=$2, season_allocation=$3 WHERE show_id=$1', [s.showId, CEIL.Premier, season]);
  const festival = (await q<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  for (const zone of ['Superior', 'Balcony'] as Zone[]) {
    const cap = (await q<{ id: string }>('INSERT INTO capacities(show_id,zone,ceiling,season_allocation) VALUES($1,$2,$3,$4) RETURNING id', [s.showId, zone, CEIL[zone], season]))[0];
    const dp = (await q<{ id: string }>("INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'DAILY',$2,1,10) RETURNING id", [cap.id, dailyOf(zone)]))[0];
    await q("INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'SEASON',$2,11,12)", [cap.id, season]);
    const p = (await q<{ id: string }>("INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id) VALUES($1,$2,$2,$3,'DAILY',35000,$4) RETURNING id", [festival.id, `Play – ${zone}`, zone, s.showId]))[0];
    await q('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [p.id, s.showId, dp.id]);
  }
  return s.showId;
}
const seasonPool = async (showId: string, zone: Zone) => (await q<{ id: string; allocation: number; held: number; committed: number }>(
  "SELECT p.id, p.allocation, p.held, p.committed FROM pools p JOIN capacities c ON c.id=p.capacity_id WHERE c.show_id=$1 AND c.zone=$2 AND p.kind='SEASON'", [showId, zone]))[0];

async function buy(user: User, productId: string) {
  const version = Number((await q<{ version: number }>('SELECT version FROM products WHERE id=$1', [productId]))[0].version);
  const co = await checkout.createCheckout(user, [{ productId, quantity: 1, version }], randomUUID());
  const o = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(o.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: o.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(o.orderId, p.id) }, user);
}

/** Production shape: 12 covered programmes, a pass per zone, 1 Front + 1 Second block pass sold, an uncovered DRAFT duplicate. */
async function productionLike() {
  const shows: string[] = [];
  for (let i = 0; i < 12; i++) shows.push(await programme(5 + i));
  // As in production: the draft duplicate has daily 60 / 80 / 40.
  const draft = await programme(17, { status: 'DRAFT', daily: { Premier: 60, Superior: 80, Balcony: 40 }, season: 30 });
  await q('UPDATE capacities SET season_allocation=NULL WHERE show_id=$1', [draft]);
  const festival = (await q<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  const passes = {} as Record<Zone, string>;
  for (const zone of ZONES) {
    passes[zone] = (await q<{ id: string }>("INSERT INTO products(festival_id,name,name_bn,category,kind,price) VALUES($1,$2,$2,$3,'SEASON',100000) RETURNING id", [festival.id, `${zone} Season`, zone]))[0].id;
    for (const id of shows) await q('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [passes[zone], id, (await seasonPool(id, zone)).id]);
  }
  await buy(await makeUser(), passes.Premier);
  await buy(await makeUser(), passes.Superior);
  return { shows, draft, passes };
}
const left = async () => Object.fromEntries((await inv.allTogetherSeats()).map((p) => [p.zone, p.remaining]));
const sellable = async (owner: User) => Object.fromEntries((await seasons.seasonsOverview(owner)).seasons.map((s) => [s.zone, s.available]));
const snapshot = async () => ({
  bookings: await q('SELECT id, status, total, snapshot FROM bookings ORDER BY id'),
  entitlements: await q('SELECT ticket_id, show_id, pool_id, status FROM entitlements ORDER BY ticket_id, show_id'),
  daily: await q("SELECT id, allocation, held, committed FROM pools WHERE kind='DAILY' ORDER BY id"),
});

test('reproduces the report: 9 / 9 / 10 left, and editing one performance never adds pass seats', { skip }, async () => {
  const { shows } = await productionLike();
  const owner = await makeUser('owner');
  assert.deepEqual(await left(), { Premier: 9, Superior: 9, Balcony: 10 });
  assert.deepEqual(await sellable(owner), { Premier: 9, Superior: 9, Balcony: 10 }, 'the Seasons tab shows the same');
  // The tester's action (audit log 13 Nov): "Season allocation" 10 -> 11 on the last programme only.
  const cap = (await q<{ id: string; version: number }>("SELECT id, version FROM capacities WHERE show_id=$1 AND zone='Premier'", [shows[11]]))[0];
  await inv.configureCapacity(owner, cap.id, { ceiling: 100, seasonAllocation: 11, dailyAllocation: 10, onlineSeasonAllocation: 11, version: cap.version });
  assert.equal((await left()).Premier, 9, 'one programme cannot raise a pass limited by all of them');
});

for (const zone of ZONES) {
  test(`add All Together seats: ${zone} gets the seats in every covered programme; nothing else changes`, { skip }, async () => {
    const { shows, draft, passes } = await productionLike();
    const owner = await makeUser('owner');
    const before = await left();
    const kept = await snapshot();
    const otherPools = await q("SELECT id, allocation FROM pools p WHERE p.kind='SEASON' ORDER BY id");
    const result = await inv.addAllTogetherSeats(owner, { zone, seats: 5, expectedAvailable: before[zone] });
    assert.deepEqual([result.before, result.after, result.programmes, result.seats], [before[zone], before[zone] + 5, 12, 5]);
    // Refreshing the admin screen shows it, and so does the Seasons tab / customer availability.
    assert.deepEqual(await left(), { ...before, [zone]: before[zone] + 5 });
    assert.equal((await sellable(owner))[zone], before[zone] + 5);
    const festivalId = (await q<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0].id;
    assert.equal((await catalogue.publicProducts(festivalId)).find((p) => p.id === passes[zone])!.available, before[zone] + 5, 'customers see it immediately');
    for (const id of shows) {
      const p = await seasonPool(id, zone);
      assert.equal(Number(p.allocation), 15, 'online seats +5 in every covered programme');
      const cap = (await q<{ season_allocation: number }>('SELECT season_allocation FROM capacities WHERE show_id=$1 AND zone=$2', [id, zone]))[0];
      assert.equal(Number(cap.season_allocation), 15, 'seats set aside +5');
    }
    // Only this zone's covered pools changed: the draft duplicate and other zones are untouched.
    const changed = (await q<{ id: string; allocation: number }>("SELECT id, allocation FROM pools p WHERE p.kind='SEASON' ORDER BY id"))
      .filter((p, i) => Number(p.allocation) !== Number((otherPools[i] as { allocation: number }).allocation));
    assert.equal(changed.length, 12);
    assert.equal(Number((await seasonPool(draft, zone)).allocation), 30, 'uncovered draft programme untouched');
    assert.deepEqual(await snapshot(), kept, 'bookings, entitlements and daily stock unchanged');
    const audit = await q<{ detail: Record<string, unknown> }>("SELECT detail FROM audit_events WHERE action='inventory.season.add_seats'");
    assert.deepEqual([audit.length, audit[0].detail.seats, audit[0].detail.before, audit[0].detail.after], [1, 5, before[zone], before[zone] + 5]);
  });
}

test('the added seats can be bought: a pass sells beyond the old limit, still never past the new one', { skip }, async () => {
  const { passes } = await productionLike();
  const owner = await makeUser('owner');
  await inv.addAllTogetherSeats(owner, { zone: 'Balcony', seats: 1, expectedAvailable: 10 });
  for (let i = 0; i < 11; i++) await buy(await makeUser(), passes.Balcony);
  assert.equal((await left()).Balcony, 0);
  const version = Number((await q<{ version: number }>('SELECT version FROM products WHERE id=$1', [passes.Balcony]))[0].version);
  await assert.rejects(checkout.createCheckout(await makeUser(), [{ productId: passes.Balcony, quantity: 1, version }], randomUUID()), /Not enough tickets remain/);
});

test('a programme without room is named and nothing is added anywhere (all or nothing)', { skip }, async () => {
  const { shows } = await productionLike();
  const owner = await makeUser('owner');
  // One covered programme's First floor daily allocation leaves room for only 5 more All Together seats.
  await q("UPDATE pools SET allocation=65 FROM capacities c WHERE c.id=pools.capacity_id AND c.show_id=$1 AND c.zone='Balcony' AND pools.kind='DAILY'", [shows[6]]);
  const title = (await q<{ title: string }>('SELECT title FROM shows WHERE id=$1', [shows[6]]))[0].title;
  const before = await q("SELECT id, allocation FROM pools ORDER BY id");
  await assert.rejects(inv.addAllTogetherSeats(owner, { zone: 'Balcony', seats: 6, expectedAvailable: 10 }),
    (e: Error & { status?: number; code?: string }) => e.status === 400 && e.code === 'SEASON_SEATS_NO_ROOM' && e.message.includes(title) && /First floor/.test(e.message));
  assert.deepEqual(await q("SELECT id, allocation FROM pools ORDER BY id"), before, 'nothing changed');
  const ok = await inv.addAllTogetherSeats(owner, { zone: 'Balcony', seats: 5, expectedAvailable: 10 });
  assert.equal(ok.after, 15, 'exactly what fits is accepted');
});

test('the uncovered draft programme no longer blocks adding seats (the old zone form refused 50)', { skip }, async () => {
  await productionLike();
  const owner = await makeUser('owner');
  await assert.rejects(inv.configureSeasonForZone(owner, 'Premier', { seasonAllocation: 50, onlineSeasonAllocation: 50 }), /cannot exceed the zone capacity \(100\)/);
  const r = await inv.addAllTogetherSeats(owner, { zone: 'Premier', seats: 41, expectedAvailable: 9 });
  assert.equal(r.after, 50);
});

test('validation: invalid zone, seat counts, no pass, roles', { skip }, async () => {
  await productionLike();
  const owner = await makeUser('owner');
  for (const zone of ['Stage', '', 'premier']) {
    await assert.rejects(inv.addAllTogetherSeats(owner, { zone, seats: 1, expectedAvailable: 9 }), (e: Error & { status?: number }) => e.status === 400, zone);
  }
  for (const seats of [0, -1, 1.5, '3', 1001, null]) {
    await assert.rejects(inv.addAllTogetherSeats(owner, { zone: 'Premier', seats, expectedAvailable: 9 }), (e: Error & { status?: number }) => e.status === 400, String(seats));
  }
  await assert.rejects(inv.addAllTogetherSeats(owner, { zone: 'Premier', seats: 1 }), (e: Error & { status?: number }) => e.status === 400);
  for (const role of ['finance', 'desk', 'scanner', 'supervisor', 'customer'] as const) {
    await assert.rejects(inv.addAllTogetherSeats(await makeUser(role), { zone: 'Premier', seats: 1, expectedAvailable: 9 }), (e: Error & { status?: number }) => e.status === 403, role);
  }
  assert.ok(await inv.addAllTogetherSeats(await makeUser('inventory'), { zone: 'Premier', seats: 1, expectedAvailable: 9 }), 'inventory managers may');
  await q("DELETE FROM product_coverage WHERE product_id IN (SELECT id FROM products WHERE kind='SEASON' AND category='Balcony')");
  await q("DELETE FROM products WHERE kind='SEASON' AND category='Balcony'");
  await assert.rejects(inv.addAllTogetherSeats(owner, { zone: 'Balcony', seats: 1, expectedAvailable: 10 }), (e: Error & { status?: number }) => e.status === 404);
  assert.equal((await q("SELECT count(*)::int n FROM audit_events WHERE action='inventory.season.add_seats'"))[0].n, 1, 'refusals leave no record');
});

test('a repeated or stale submission never adds twice; concurrent additions do not double up', { skip }, async () => {
  await productionLike();
  const owner = await makeUser('owner');
  await inv.addAllTogetherSeats(owner, { zone: 'Superior', seats: 3, expectedAvailable: 9 });
  await assert.rejects(inv.addAllTogetherSeats(owner, { zone: 'Superior', seats: 3, expectedAvailable: 9 }),
    (e: Error & { status?: number }) => e.status === 409 && /now has 12/.test(e.message), 'double click / second tab');
  assert.equal((await left()).Superior, 12);
  const results = await Promise.allSettled([1, 2, 3].map(() => inv.addAllTogetherSeats(owner, { zone: 'Superior', seats: 2, expectedAvailable: 12 })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await left()).Superior, 14);
});

test('daily seats per performance still work as before', { skip }, async () => {
  const { shows } = await productionLike();
  const owner = await makeUser('owner');
  const cap = (await q<{ id: string; version: number }>("SELECT id, version FROM capacities WHERE show_id=$1 AND zone='Premier'", [shows[0]]))[0];
  await inv.configureCapacity(owner, cap.id, { ceiling: 100, seasonAllocation: 10, dailyAllocation: 13, onlineSeasonAllocation: 10, version: cap.version });
  const daily = (await q<{ allocation: number }>("SELECT p.allocation FROM pools p JOIN capacities c ON c.id=p.capacity_id WHERE c.show_id=$1 AND c.zone='Premier' AND p.kind='DAILY'", [shows[0]]))[0];
  assert.equal(Number(daily.allocation), 13);
  assert.deepEqual(await left(), { Premier: 9, Superior: 9, Balcony: 10 }, 'pass seats unaffected by a daily change');
});
