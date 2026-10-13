/**
 * The operator's season-ticket switch (SEASON_TICKET_SALES_ENABLED, a runtime setting; no
 * database column, so the schema before migration 0010 is enough): closed by default, every
 * purchase entry point (single hold, cart checkout, payment order for an earlier hold) refuses
 * NEW season sales while it is off without creating bookings or payment orders, daily tickets,
 * existing season bookings and completed payments are untouched, it never overrides the global
 * ALLOW_PUBLIC_SALES switch, and the dashboard only reads it. No application code references
 * festivals.season_sales_open. Real catalogue, cart, checkout and payment code on the local test
 * database; Razorpay/Resend are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeSeason, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
  process.env.SEASON_TICKET_SALES_ENABLED = 'true';
  await resetDatabase();
});

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);
const closeSeason = () => { process.env.SEASON_TICKET_SALES_ENABLED = 'false'; };
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

test('season switch: closed unless SEASON_TICKET_SALES_ENABLED is exactly "true"; daily tickets never depend on it', () => {
  const saved = process.env.SEASON_TICKET_SALES_ENABLED;
  try {
    for (const value of [undefined, '', 'false', '1', 'yes', 'open']) {
      if (value === undefined) delete process.env.SEASON_TICKET_SALES_ENABLED; else process.env.SEASON_TICKET_SALES_ENABLED = value;
      assert.equal(seasonSaleBlocked('SEASON'), true, String(value));
      assert.equal(seasonSaleBlocked('DAILY'), false, String(value));
    }
    for (const value of ['true', 'TRUE', ' true ']) {
      process.env.SEASON_TICKET_SALES_ENABLED = value;
      assert.equal(seasonSaleBlocked('SEASON'), false, value);
    }
  } finally {
    if (saved === undefined) delete process.env.SEASON_TICKET_SALES_ENABLED; else process.env.SEASON_TICKET_SALES_ENABLED = saved;
  }
});

test('season switch: the dashboard reads it (owner and inventory only) and cannot change it', { skip }, async () => {
  for (const role of ['owner', 'inventory'] as Role[]) {
    const admin = await makeUser(role);
    assert.deepEqual(catalogue.seasonSalesState(admin), { open: true, setting: 'SEASON_TICKET_SALES_ENABLED' }, role);
  }
  closeSeason();
  assert.equal(catalogue.seasonSalesState(await makeUser('owner')).open, false);
  for (const role of ['finance', 'desk', 'scanner', 'supervisor', 'customer'] as Role[]) {
    const user = await makeUser(role);
    assert.throws(() => catalogue.seasonSalesState(user), /permission/, role);
  }
  const route = await import('../app/api/admin/festival/season-sales/route');
  assert.deepEqual(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k)), ['GET'], 'no write endpoint');
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'festival.season%'"), 0);
});

test('no application code depends on migration 0010 (festivals.season_sales_open)', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|sql)$/.test(name)) files.push(path);
    }
  };
  for (const dir of ['src', 'app', 'db/migrations', 'proxy.ts'].filter((d) => { try { statSync(d); return true; } catch { return false; } })) {
    if (statSync(dir).isDirectory()) walk(dir); else files.push(dir);
  }
  const offenders = files.filter((path) => readFileSync(path, 'utf8').includes('season_sales_open'));
  assert.deepEqual(offenders, []);
});

test('the test database has the pre-0010 schema the application uses (no season_sales_open column)', { skip }, async () => {
  assert.equal(await count("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='festivals' AND column_name='season_sales_open'"), 0);
  const { GET } = await import('../app/api/health/route');
  const body = await (await GET()).json();
  assert.deepEqual([body.db, body.schema, body.config, body.publicSales, body.seasonSales], [true, true, true, true, true]);
  closeSeason();
  const closed = await (await GET()).json();
  assert.deepEqual([closed.publicSales, closed.seasonSales], [true, false], 'health reports season sales closed');
});

// ---- PURCHASES WHILE CLOSED --------------------------------------------------------------------------

test('closed: single hold and cart checkout of a season ticket are refused; nothing is created or charged', { skip }, async () => {
  const { a, season } = await setup();
  closeSeason();
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
  closeSeason();
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
  closeSeason();
  assert.deepEqual(await state(), { season: 'CLOSED', daily: 'SELLABLE', cartSeason: 'CLOSED', cartDaily: 'SELLABLE' });
  assert.equal((await cart.readAccountCart(buyer.id)).length, 2, 'the cart line is kept, not deleted');
});

test('closed after a hold: no NEW payment order for the held season ticket (cart and single paths); the hold just expires', { skip }, async () => {
  const { season } = await setup();
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(season)], randomUUID());
  const single = await commerce.reserve(await makeUser(), line(season), randomUUID());
  closeSeason();
  await assert.rejects(checkout.createCheckoutPaymentOrder(buyer, co.id), CLOSED);
  const singleOwner = (await query<User>('SELECT u.* FROM users u JOIN bookings b ON b.user_id=u.id WHERE b.id=$1', [single.id]))[0];
  await assert.rejects(payments.createPaymentOrder(singleOwner, single.id), CLOSED);
  assert.equal(fake.count('POST /orders'), 0, 'no Razorpay order');
  assert.equal(await count('SELECT count(*)::int n FROM payment_attempts'), 0);
  assert.equal(await count("SELECT count(*)::int n FROM bookings WHERE status='HELD'"), 2, 'still plain holds (not marked as paying); they expire as usual');
});

test('closed after paying: existing season bookings, tickets and payments are untouched; a payment already made in an open order is honoured', { skip }, async () => {
  const { season } = await setup();
  const earlier = await makeUser();
  const co = await checkout.createCheckout(earlier, [line(season, 2)], randomUUID());
  await pay(earlier, co.id);
  // A second customer had the Razorpay window open when sales closed, then paid.
  const late = await makeUser();
  const lateCo = await checkout.createCheckout(late, [line(season)], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(late, lateCo.id);
  const before = await query('SELECT id,status,total FROM bookings ORDER BY id');
  closeSeason();
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
  closeSeason();
  process.env.SEASON_TICKET_SALES_ENABLED = 'true';
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
