/**
 * The admin's season-ticket sales switch (festivals.season_sales_open, migration 0010):
 * who may read and change it, that it persists, that every purchase entry point (single
 * hold, cart checkout, payment order for an earlier hold) refuses NEW season sales while it
 * is off without creating bookings or payment orders, that daily tickets, existing season
 * bookings and completed payments are untouched, and that it never overrides the global
 * ALLOW_PUBLIC_SALES switch. Real catalogue, cart, checkout and payment code on the local
 * test database; Razorpay/Resend are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeSeason, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import { seasonSaleBlocked } from '../src/lib/availability';
import type { Role, User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let catalogue: typeof import('../src/lib/catalogue');
let checkout: typeof import('../src/lib/checkout');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let cart: typeof import('../src/lib/account-cart');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  catalogue = await import('../src/lib/catalogue');
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
  await resetDatabase();
});

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);
const stored = async () => (await query<{ open: boolean }>('SELECT season_sales_open open FROM festivals LIMIT 1'))[0].open;
const owner = () => makeUser('owner');
const CLOSED = /Season-ticket sales are currently closed/;

/** Two published performances, a daily ticket for each and a season ticket covering both. */
async function setup() {
  const a = await makeShow({ startsInMinutes: 3 * 24 * 60 });
  const b = await makeShow({ startsInMinutes: 4 * 24 * 60 });
  const season = await makeSeason([a, b]);
  return { a, b, season };
}
const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });
async function pay(user: User, checkoutId: string) {
  const order = await checkout.createCheckoutPaymentOrder(user, checkoutId);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
}
async function nothingCreated() {
  assert.equal(await count('SELECT count(*)::int n FROM bookings'), 0, 'no booking');
  assert.equal(await count('SELECT count(*)::int n FROM checkouts'), 0, 'no checkout');
  assert.equal(await count('SELECT count(*)::int n FROM payment_attempts'), 0, 'no payment attempt');
  assert.equal(await count('SELECT COALESCE(sum(held+committed),0)::int n FROM pools'), 0, 'no seat held');
  assert.equal(fake.count('POST /orders'), 0, 'no Razorpay order');
}

// ---- THE SWITCH -------------------------------------------------------------------------------------

test('season switch: owner and inventory read and change it; every other role and customers are refused', { skip }, async () => {
  await setup();
  for (const role of ['owner', 'inventory'] as Role[]) {
    const admin = await makeUser(role);
    assert.deepEqual(await catalogue.setSeasonSales(admin, { open: false }), { open: false, migrated: true }, role);
    assert.deepEqual(await catalogue.seasonSalesState(admin), { open: false, migrated: true }, role);
    assert.deepEqual(await catalogue.setSeasonSales(admin, { open: true }), { open: true, migrated: true }, role);
  }
  for (const role of ['finance', 'desk', 'scanner', 'supervisor', 'customer'] as Role[]) {
    const user = await makeUser(role);
    await assert.rejects(catalogue.setSeasonSales(user, { open: false }), /permission/, role);
    await assert.rejects(catalogue.seasonSalesState(user), /permission/, role);
  }
  assert.equal(await stored(), true, 'refused attempts changed nothing');
});

test('season switch: invalid bodies are refused and change nothing; changes are audited, repeats are not', { skip }, async () => {
  await setup();
  const admin = await owner();
  for (const body of [{}, { open: 'false' }, { open: 0 }, { open: null }, [], null] as unknown[]) {
    await assert.rejects(catalogue.setSeasonSales(admin, body as Record<string, unknown>), /Send \{"open": true\}/, JSON.stringify(body));
  }
  assert.equal(await stored(), true);
  await catalogue.setSeasonSales(admin, { open: false });
  await catalogue.setSeasonSales(admin, { open: false });
  const audits = await query<{ meta: unknown }>("SELECT * FROM audit_events WHERE action='festival.season_sales'");
  assert.equal(audits.length, 1, 'one change, one audit row');
});

test('season switch: persisted in the database; concurrent changes leave one consistent stored state', { skip }, async () => {
  await setup();
  const admin = await owner();
  await catalogue.setSeasonSales(admin, { open: false });
  assert.equal(await stored(), false, 'stored, not in memory');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => catalogue.setSeasonSales(admin, { open: i % 2 === 0 })));
  for (const r of results) assert.equal(typeof r.open, 'boolean');
  const final = await stored();
  assert.equal((await catalogue.seasonSalesState(admin)).open, final, 'what the dashboard reads is what is stored');
  assert.equal(await count('SELECT count(*)::int n FROM festivals'), 1);
});

test('migration default: a festival created without the switch has season sales CLOSED', { skip }, async () => {
  await query(`INSERT INTO festivals(name,name_bn,venue,address,status,contact_email,terms) VALUES('F','F','V','A','PUBLISHED','x@tickets.test','T')`);
  assert.equal(await stored(), false);
});

test('seasonSaleBlocked: only an explicit true opens season sales; daily tickets never depend on it', () => {
  for (const value of [false, null, undefined, 'true', 1]) assert.equal(seasonSaleBlocked('SEASON', value), true, String(value));
  assert.equal(seasonSaleBlocked('SEASON', true), false);
  for (const value of [false, null, undefined]) assert.equal(seasonSaleBlocked('DAILY', value), false);
});

// ---- PURCHASES WHILE CLOSED --------------------------------------------------------------------------

test('closed: single hold and cart checkout of a season ticket are refused; nothing is created or charged', { skip }, async () => {
  const { a, season } = await setup();
  await catalogue.setSeasonSales(await owner(), { open: false });
  const buyer = await makeUser();
  await assert.rejects(commerce.reserve(buyer, line(season), randomUUID()), CLOSED);
  await assert.rejects(checkout.createCheckout(buyer, [line(season)], randomUUID()),
    (e: unknown) => e instanceof Error && CLOSED.test(e.message) && (e as { code?: string }).code === 'SEASON_SALES_CLOSED');
  // A cart mixing a daily and a season ticket is refused as a whole (all-or-nothing checkout).
  await assert.rejects(checkout.createCheckout(buyer, [line(a), line(season)], randomUUID()), CLOSED);
  await nothingCreated();
});

test('closed: daily tickets still sell end to end (hold, cart, Razorpay order, verification, confirmation)', { skip }, async () => {
  const { a, b } = await setup();
  await catalogue.setSeasonSales(await owner(), { open: false });
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(a, 2), line(b)], randomUUID());
  await pay(buyer, co.id);
  assert.equal((await checkout.checkoutReceipt(buyer.id, co.id)).status, 'CONFIRMED');
  assert.equal(await count("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.user_id=$1 AND t.status='ACTIVE'", [buyer.id]), 3);
  // The single-booking path too.
  const held = await commerce.reserve(buyer, line(a), randomUUID());
  const order = await payments.createPaymentOrder(buyer, held.id);
  assert.ok(order.orderId);
});

test('closed: catalogue and cart show the season ticket as closed; daily tickets stay sellable', { skip }, async () => {
  const { a, season } = await setup();
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  const buyer = await makeUser();
  await cart.saveAccountCart(buyer.id, [{ productId: season.productId, quantity: 1 }, { productId: a.productId, quantity: 1 }]);
  const state = async () => {
    const listed = await catalogue.publicProducts(festival.id);
    const lines = await cart.readAccountCart(buyer.id);
    return {
      season: listed.find((p) => p.id === season.productId)?.state,
      daily: listed.find((p) => p.id === a.productId)?.state,
      cartSeason: lines.find((l) => l.productId === season.productId)?.state,
      cartDaily: lines.find((l) => l.productId === a.productId)?.state,
    };
  };
  assert.deepEqual(await state(), { season: 'SELLABLE', daily: 'SELLABLE', cartSeason: 'SELLABLE', cartDaily: 'SELLABLE' });
  await catalogue.setSeasonSales(await owner(), { open: false });
  assert.deepEqual(await state(), { season: 'CLOSED', daily: 'SELLABLE', cartSeason: 'CLOSED', cartDaily: 'SELLABLE' });
  assert.equal((await cart.readAccountCart(buyer.id)).length, 2, 'the cart line is kept, not deleted');
});

test('closed after a hold: no NEW payment order for the held season ticket (cart and single paths); the hold just expires', { skip }, async () => {
  const { season } = await setup();
  const admin = await owner();
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(season)], randomUUID());
  const single = await commerce.reserve(await makeUser(), line(season), randomUUID());
  await catalogue.setSeasonSales(admin, { open: false });
  await assert.rejects(checkout.createCheckoutPaymentOrder(buyer, co.id), CLOSED);
  const singleOwner = (await query<User>('SELECT u.* FROM users u JOIN bookings b ON b.user_id=u.id WHERE b.id=$1', [single.id]))[0];
  await assert.rejects(payments.createPaymentOrder(singleOwner, single.id), CLOSED);
  assert.equal(fake.count('POST /orders'), 0, 'no Razorpay order');
  assert.equal(await count('SELECT count(*)::int n FROM payment_attempts'), 0);
  assert.equal(await count("SELECT count(*)::int n FROM bookings WHERE status='HELD'"), 2, 'still plain holds (not marked as paying); they expire as usual');
});

test('closed after paying: existing season bookings, tickets and payments are untouched; a payment already made in an open order is honoured', { skip }, async () => {
  const { season } = await setup();
  const admin = await owner();
  const earlier = await makeUser();
  const co = await checkout.createCheckout(earlier, [line(season, 2)], randomUUID());
  await pay(earlier, co.id);
  // A second customer had the Razorpay window open when sales closed, then paid.
  const late = await makeUser();
  const lateCo = await checkout.createCheckout(late, [line(season)], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(late, lateCo.id);
  const before = await query('SELECT id,status,total FROM bookings ORDER BY id');
  await catalogue.setSeasonSales(admin, { open: false });
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, late);
  assert.equal((await checkout.checkoutReceipt(earlier.id, co.id)).status, 'CONFIRMED');
  assert.equal((await checkout.checkoutReceipt(late.id, lateCo.id)).status, 'CONFIRMED', 'a completed payment is not refused or refunded');
  assert.equal(await count("SELECT count(*)::int n FROM refunds"), 0);
  assert.equal(await count("SELECT count(*)::int n FROM tickets WHERE status<>'ACTIVE'"), 0, 'tickets stay valid');
  assert.equal(await count("SELECT count(*)::int n FROM entitlements WHERE status<>'ACTIVE'"), 0, 'admission rights stay valid');
  const earlierBooking = before.find((b) => (b as { status: string }).status === 'CONFIRMED');
  assert.ok(earlierBooking, 'the earlier purchase was already confirmed before the switch');
});

test('reopened: the season purchase flow works again exactly as before', { skip }, async () => {
  const { season } = await setup();
  const admin = await owner();
  await catalogue.setSeasonSales(admin, { open: false });
  await catalogue.setSeasonSales(admin, { open: true });
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(season)], randomUUID());
  await pay(buyer, co.id);
  assert.equal((await checkout.checkoutReceipt(buyer.id, co.id)).status, 'CONFIRMED');
  assert.equal(Number((await query<{ total: number }>('SELECT total FROM checkouts WHERE id=$1', [co.id]))[0].total), season.price, 'same price');
});

test('the season switch never overrides the global switch: with ALLOW_PUBLIC_SALES off nothing sells, season open or not', { skip }, async () => {
  const { a, season } = await setup();
  const saved = process.env.ALLOW_PUBLIC_SALES;
  process.env.ALLOW_PUBLIC_SALES = 'false';
  try {
    const buyer = await makeUser();
    await assert.rejects(checkout.createCheckout(buyer, [line(season)], randomUUID()), /Ticket sales are paused/);
    await assert.rejects(checkout.createCheckout(buyer, [line(a)], randomUUID()), /Ticket sales are paused/);
    await nothingCreated();
  } finally {
    process.env.ALLOW_PUBLIC_SALES = saved;
  }
});
