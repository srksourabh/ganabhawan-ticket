/**
 * Root cause of "Sales closed" on every season ticket in production: each season ticket
 * covered performances that were later CANCELLED, and the sales rule required EVERY covered
 * performance to be published, so no switch could open it. New sales now cover the remaining
 * (not cancelled) performances; draft or started ones still close sales. The catalogue, cart,
 * hold, checkout reuse and payment order apply the same gates (ALLOW_PUBLIC_SALES,
 * SEASON_TICKET_SALES_ENABLED, "On sale", window and stock) for every combination.
 * Real catalogue, cart, checkout and payment code on the local test database (schema without
 * migration 0010); Razorpay/Resend are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeSeason, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

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
  process.env.ALLOW_PUBLIC_SALES = 'true';
  process.env.SEASON_TICKET_SALES_ENABLED = 'true';
  await resetDatabase();
});

const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params))[0].n);
const line = (p: { productId: string }, quantity = 1, version = 1) => ({ productId: p.productId, quantity, version });
const festivalId = async () => (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0].id;
const listed = async (productId: string) => (await catalogue.publicProducts(await festivalId())).find((p) => p.id === productId);
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

test('a season ticket covering a cancelled performance is SELLABLE for the remaining ones and sells end to end', { skip }, async () => {
  const { shows, season } = await seasonOfThree();
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [shows[1].showId]);
  const product = await listed(season.productId);
  assert.equal(product?.state, 'SELLABLE', 'was CLOSED before the fix (production symptom)');
  assert.equal(product?.coverage.length, 2, 'customers see the two remaining performances');
  const buyer = await makeUser();
  const co = await buySeason(buyer, season.productId);
  assert.equal((await checkout.checkoutReceipt(buyer.id, co.id)).status, 'CONFIRMED');
  const shown = (await query<{ show_id: string }>('SELECT e.show_id FROM entitlements e JOIN tickets t ON t.id=e.ticket_id JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1', [co.id])).map((r) => r.show_id).sort();
  assert.deepEqual(shown, [shows[0].showId, shows[2].showId].sort(), 'admission rights only for the remaining performances');
  assert.equal(await count('SELECT held+committed n FROM pools WHERE id=$1', [shows[1].seasonPoolId]), 0, 'no seat taken in the cancelled performance');
  const snapshot = (await query<{ snapshot: { coverage: unknown[] } }>('SELECT snapshot FROM bookings WHERE checkout_id=$1', [co.id]))[0].snapshot;
  assert.equal(snapshot.coverage.length, 2);
});


test('a draft or already-started covered performance still closes the season; all cancelled = closed', { skip }, async () => {
  const { shows, season } = await seasonOfThree();
  await query("UPDATE shows SET status='DRAFT' WHERE id=$1", [shows[2].showId]);
  assert.equal((await listed(season.productId))?.state, 'CLOSED');
  await assert.rejects(checkout.createCheckout(await makeUser(), [line(season)], randomUUID()), /Sales for this performance have closed/);
  await query("UPDATE shows SET status='PUBLISHED' WHERE id=$1", [shows[2].showId]);
  await query("UPDATE shows SET starts_at=now()-interval '1 minute' WHERE id=$1", [shows[0].showId]);
  assert.equal((await listed(season.productId))?.state, 'CLOSED', 'season sales close at the first remaining curtain');
  await query("UPDATE shows SET status='CANCELLED'");
  await assert.rejects(checkout.createCheckout(await makeUser(), [line(season)], randomUUID()), /closed/);
  assert.equal(await count('SELECT count(*)::int n FROM bookings'), 0);
});


test('catalogue, cart, hold and checkout agree for every combination of the switches and "On sale"', { skip }, async () => {
  const { shows, season } = await seasonOfThree();
  const buyer = await makeUser();
  await cart.saveAccountCart(buyer.id, [{ productId: season.productId, quantity: 1 }]);
  const combos = [
    { publicSales: 'true', seasonSwitch: 'true', enabled: true, sells: true },
    { publicSales: 'true', seasonSwitch: undefined, enabled: true, sells: false },
    { publicSales: 'true', seasonSwitch: 'false', enabled: true, sells: false },
    { publicSales: 'true', seasonSwitch: 'yes', enabled: true, sells: false },
    { publicSales: 'false', seasonSwitch: 'true', enabled: true, sells: false },
    { publicSales: 'true', seasonSwitch: 'true', enabled: false, sells: false },
  ];
  for (const combo of combos) {
    process.env.ALLOW_PUBLIC_SALES = combo.publicSales;
    if (combo.seasonSwitch === undefined) delete process.env.SEASON_TICKET_SALES_ENABLED; else process.env.SEASON_TICKET_SALES_ENABLED = combo.seasonSwitch;
    await query('UPDATE products SET enabled=$1 WHERE id=$2', [combo.enabled, season.productId]);
    const label = JSON.stringify(combo);
    const catalogueState = (await listed(season.productId))?.state;
    const cartState = (await cart.readAccountCart(buyer.id)).find((l) => l.productId === season.productId)?.state;
    if (combo.sells) {
      assert.equal(catalogueState, 'SELLABLE', label);
      assert.equal(cartState, 'SELLABLE', label);
      const co = await checkout.createCheckout(buyer, [line(season)], randomUUID());
      await checkout.createCheckoutPaymentOrder(buyer, co.id);
    } else {
      assert.equal(catalogueState, combo.enabled ? 'CLOSED' : undefined, label + ' (a product not on sale is not listed)');
      assert.equal(cartState, combo.enabled ? 'CLOSED' : 'UNAVAILABLE', label);
      const ordersBefore = fake.count('POST /orders');
      const bookingsBefore = await count('SELECT count(*)::int n FROM bookings');
      await assert.rejects(checkout.createCheckout(buyer, [line(season)], randomUUID()), label);
      await assert.rejects(commerce.reserve(buyer, line(season), randomUUID()), label);
      assert.equal(fake.count('POST /orders'), ordersBefore, label);
      assert.equal(await count('SELECT count(*)::int n FROM bookings'), bookingsBefore, label);
    }
  }
  // Daily tickets sell with season sales closed.
  delete process.env.SEASON_TICKET_SALES_ENABLED;
  process.env.ALLOW_PUBLIC_SALES = 'true';
  const daily = await checkout.createCheckout(await makeUser(), [line(shows[0])], randomUUID());
  assert.ok(daily.id);
});


test('"On sale" switched off after a hold: no new payment order (cart and single); a paid booking keeps its tickets', { skip }, async () => {
  const show = await makeShow();
  const paid = await makeUser();
  const paidCo = await checkout.createCheckout(paid, [line(show)], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(paid, paidCo.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, paid);
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(show)], randomUUID());
  const single = await commerce.reserve(await makeUser(), line(show), randomUUID());
  const ordersBefore = fake.count('POST /orders');
  await query('UPDATE products SET enabled=false WHERE id=$1', [show.productId]);
  await assert.rejects(checkout.createCheckoutPaymentOrder(buyer, co.id), /not available/);
  await assert.rejects(checkout.createCheckout(buyer, [line(show)], randomUUID()), /not available/, 'reusing the open checkout is refused too');
  const singleOwner = (await query<User>('SELECT u.* FROM users u JOIN bookings b ON b.user_id=u.id WHERE b.id=$1', [single.id]))[0];
  await assert.rejects(payments.createPaymentOrder(singleOwner, single.id), /not available/);
  assert.equal(fake.count('POST /orders'), ordersBefore);
  assert.equal((await checkout.checkoutReceipt(paid.id, paidCo.id)).status, 'CONFIRMED');
  assert.equal(await count("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND t.status='ACTIVE'", [paidCo.id]), 1);
});
