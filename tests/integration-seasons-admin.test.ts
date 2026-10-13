/**
 * Season management (seasons.ts, admin Seasons tab): list, create, edit, performances and
 * delete; roles, validation, concurrency and history protection, and that the season-sales
 * switch has no write endpoint. Real catalogue, cart, checkout and payment code on the local
 * test database (schema without migration 0010); Razorpay/Resend are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeSeason, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { Role, User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let seasons: typeof import('../src/lib/seasons');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let cart: typeof import('../src/lib/account-cart');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  seasons = await import('../src/lib/seasons');
  checkout = await import('../src/lib/checkout');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  cart = await import('../src/lib/account-cart');
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

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);
const line = (p: { productId: string }, quantity = 1, version = 1) => ({ productId: p.productId, quantity, version });
async function buySeason(user: User, productId: string, version = 1) {
  const co = await checkout.createCheckout(user, [{ productId, quantity: 1, version }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return co;
}
/** Three performances and a season ticket covering all three (like production: some later cancelled). */
async function seasonOfThree() {
  const shows = [await makeShow({ startsInMinutes: 3 * 24 * 60 }), await makeShow({ startsInMinutes: 4 * 24 * 60 }), await makeShow({ startsInMinutes: 5 * 24 * 60 })];
  return { shows, season: await makeSeason(shows) };
}

// ---- SEASON MANAGEMENT --------------------------------------------------------------------------------

test('seasons: owner and inventory list them with performances, sales state and reasons; others are refused', { skip }, async () => {
  const { shows, season } = await seasonOfThree();
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [shows[1].showId]);
  for (const role of ['owner', 'inventory'] as Role[]) {
    const view = await seasons.seasonsOverview(await makeUser(role));
    assert.deepEqual(view.sales, { configured: true, publicSales: true, seasonSwitch: true, open: true, setting: 'SEASON_TICKET_SALES_ENABLED', seasonBlocked: false });
    const s = view.seasons.find((x) => x.id === season.productId)!;
    assert.equal(s.open, true, role);
    assert.equal(s.performances.length, 3);
    assert.equal(s.performances.filter((p) => p.status === 'CANCELLED').length, 1);
    assert.equal(s.deletable, true);
    assert.deepEqual(view.zonesWithoutSeason, ['Superior', 'Balcony']);
  }
  delete process.env.SEASON_TICKET_SALES_ENABLED;
  const closed = (await seasons.seasonsOverview(await makeUser('owner'))).seasons[0];
  assert.equal(closed.open, false);
  assert.ok(closed.closedReasons.some((r) => /SEASON_TICKET_SALES_ENABLED/.test(r)));
  for (const role of ['finance', 'desk', 'scanner', 'supervisor', 'customer'] as Role[]) {
    const user = await makeUser(role);
    await assert.rejects(seasons.seasonsOverview(user), /permission/, role);
    await assert.rejects(seasons.createSeason(user, { zone: 'Balcony', name: 'S', nameBn: 'S', price: 100 }), /permission/, role);
    await assert.rejects(seasons.updateSeason(user, season.productId, { price: 1, version: 1 }), /permission/, role);
    await assert.rejects(seasons.deleteSeason(user, season.productId), /permission/, role);
    await assert.rejects(seasons.addSeasonPerformance(user, season.productId, shows[0].showId), /permission/, role);
    await assert.rejects(seasons.removeSeasonPerformance(user, season.productId, shows[0].showId), /permission/, role);
  }
  assert.equal(await count("SELECT count(*)::int n FROM products WHERE kind='SEASON'"), 1, 'refused calls changed nothing');
});

test('seasons: create validates input, one per zone, covers the upcoming published performances', { skip }, async () => {
  const shows = [await makeShow({ startsInMinutes: 2 * 24 * 60 }), await makeShow({ startsInMinutes: 3 * 24 * 60 })];
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [shows[1].showId]);
  const owner = await makeUser('owner');
  for (const bad of [
    { zone: 'Gallery', name: 'S', nameBn: 'S', price: 100 },
    { zone: 'Premier', name: '', nameBn: 'S', price: 100 },
    { zone: 'Premier', name: 'S', nameBn: 'S', price: 0 },
    { zone: 'Premier', name: 'S', nameBn: 'S', price: 1.5 },
    { zone: 'Premier', name: 'S', nameBn: 'S', price: 100, kind: 'DAILY' },
    { zone: 'Premier', name: 'S', nameBn: 'S', price: 100, enabled: false, version: 9 },
  ]) await assert.rejects(seasons.createSeason(owner, bad), JSON.stringify(bad));
  const created = await seasons.createSeason(owner, { zone: 'Premier', name: 'Premier season', nameBn: 'প্রিমিয়ার সিজন', price: 160000 }) as { id: string; coverage: number };
  assert.equal(created.coverage, 1, 'the cancelled performance is not added');
  await assert.rejects(seasons.createSeason(owner, { zone: 'Premier', name: 'Again', nameBn: 'S', price: 100 }), /already exists/);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action='product.season.create'"), 1);
});

test('seasons: edit changes only the fields sent, refuses protected fields, bad values and stale versions', { skip }, async () => {
  const { season } = await seasonOfThree();
  const owner = await makeUser('inventory');
  const before = (await query('SELECT name, name_bn, price, enabled, category, kind FROM products WHERE id=$1', [season.productId]))[0];
  for (const bad of [
    { price: 5, version: 1, category: 'Balcony' },
    { price: 5, version: 1, kind: 'DAILY' },
    { price: 5, version: 1, festival_id: randomUUID() },
    { price: -1, version: 1 },
    { price: '500', version: 1 },
    { name: '   ', version: 1 },
    { enabled: 'yes', version: 1 },
    { price: 5 },
  ] as Record<string, unknown>[]) await assert.rejects(seasons.updateSeason(owner, season.productId, bad), JSON.stringify(bad));
  assert.deepEqual((await query('SELECT name, name_bn, price, enabled, category, kind FROM products WHERE id=$1', [season.productId]))[0], before, 'nothing changed');
  const updated = await seasons.updateSeason(owner, season.productId, { price: 250000, version: 1 });
  assert.deepEqual([updated.price, updated.name, updated.nameBn, updated.enabled, updated.version], [250000, before.name, before.name_bn, before.enabled, 2]);
  await assert.rejects(seasons.updateSeason(owner, season.productId, { enabled: false, version: 1 }), /changed by someone else/, 'stale version');
  await seasons.updateSeason(owner, season.productId, { enabled: false, name: 'Renamed', version: 2 });
  const row = (await query<{ enabled: boolean; name: string; price: number }>('SELECT enabled, name, price FROM products WHERE id=$1', [season.productId]))[0];
  assert.deepEqual([row.enabled, row.name, Number(row.price)], [false, 'Renamed', 250000]);
  await assert.rejects(seasons.updateSeason(owner, randomUUID(), { price: 5, version: 1 }), /not found/);
  const daily = (await query<{ id: string }>("SELECT id FROM products WHERE kind='DAILY' LIMIT 1"))[0];
  await assert.rejects(seasons.updateSeason(owner, daily.id, { price: 5, version: 1 }), /not found/, 'daily tickets are not edited here');
});

test('seasons: performances can be added or removed before any sale, never after, never the last one', { skip }, async () => {
  const { shows, season } = await seasonOfThree();
  const extra = await makeShow({ startsInMinutes: 6 * 24 * 60 });
  const owner = await makeUser('owner');
  await seasons.removeSeasonPerformance(owner, season.productId, shows[2].showId);
  await seasons.addSeasonPerformance(owner, season.productId, extra.showId);
  await assert.rejects(seasons.removeSeasonPerformance(owner, season.productId, randomUUID()), /not part of/);
  await seasons.removeSeasonPerformance(owner, season.productId, shows[1].showId);
  await seasons.removeSeasonPerformance(owner, season.productId, extra.showId);
  await assert.rejects(seasons.removeSeasonPerformance(owner, season.productId, shows[0].showId), /at least one performance/);
  await seasons.addSeasonPerformance(owner, season.productId, shows[1].showId);
  const version = Number((await query<{ version: number }>('SELECT version FROM products WHERE id=$1', [season.productId]))[0].version);
  await buySeason(await makeUser(), season.productId, version);
  await assert.rejects(seasons.removeSeasonPerformance(owner, season.productId, shows[1].showId), /already been booked/);
  await assert.rejects(seasons.addSeasonPerformance(owner, season.productId, shows[2].showId), /already been sold/);
});

test('seasons: delete removes a never-booked season ticket; one with any booking or attempt is kept (409) with its history', { skip }, async () => {
  const { shows, season } = await seasonOfThree();
  const owner = await makeUser('owner');
  const other = await makeSeason([shows[0]], 90000);
  await query("UPDATE products SET category='Balcony' WHERE id=$1", [other.productId]);
  const buyer = await makeUser();
  await cart.saveAccountCart(buyer.id, [{ productId: other.productId, quantity: 1 }]);
  assert.deepEqual(await seasons.deleteSeason(owner, other.productId), { deleted: other.productId });
  assert.equal(await count('SELECT count(*)::int n FROM products WHERE id=$1', [other.productId]), 0);
  assert.equal(await count('SELECT count(*)::int n FROM cart_items WHERE product_id=$1', [other.productId]), 0, 'unpaid cart line removed with it');
  assert.equal(await count('SELECT count(*)::int n FROM shows'), 3, 'performances are not touched');
  // Booked once (even an expired hold): never deleted.
  const held = await commerce.reserve(buyer, line(season), randomUUID());
  await query("UPDATE bookings SET status='EXPIRED' WHERE id=$1", [held.id]);
  await assert.rejects(seasons.deleteSeason(owner, season.productId), (e: unknown) => (e as { code?: string }).code === 'SEASON_HAS_HISTORY' && /history is kept/.test((e as Error).message));
  assert.equal(await count('SELECT count(*)::int n FROM products WHERE id=$1', [season.productId]), 1);
  assert.equal(await count('SELECT count(*)::int n FROM product_coverage WHERE product_id=$1', [season.productId]), 3);
  assert.equal((await seasons.seasonsOverview(owner)).seasons[0].deletable, false);
  await assert.rejects(seasons.deleteSeason(owner, 'not-a-uuid'), /not found/);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action='product.season.delete'"), 1);
});

test('seasons API routes: the switch has no write endpoint; season routes use the admin catalogue roles', async () => {
  const list = await import('../app/api/admin/seasons/route');
  const one = await import('../app/api/admin/seasons/[id]/route');
  const add = await import('../app/api/admin/seasons/[id]/coverage/route');
  const remove = await import('../app/api/admin/seasons/[id]/coverage/[showId]/route');
  const methods = (m: object) => Object.keys(m).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k)).sort();
  assert.deepEqual([methods(list), methods(one), methods(add), methods(remove)], [['GET', 'POST'], ['DELETE', 'PATCH'], ['POST'], ['DELETE']]);
  const sw = await import('../app/api/admin/festival/season-sales/route');
  assert.deepEqual(methods(sw), ['GET']);
});
