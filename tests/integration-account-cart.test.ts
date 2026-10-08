/**
 * The server-stored account cart: guest→account merge (once per guest cart),
 * survival across sign-out / session expiry, isolation between accounts, and
 * expiry by real show times (daily: its show; season: its LAST covered show).
 * Selections only: these operations never hold inventory, book or charge.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeSeason, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let cart: typeof import('../src/lib/account-cart');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let jobs: typeof import('../src/lib/jobs');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  cart = await import('../src/lib/account-cart');
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
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
  await resetDatabase();
});

const guest = () => 'guest' + randomUUID().replace(/-/g, '').slice(0, 20);
const lines = (rows: { productId: string; quantity: number }[]) => rows.map((r) => [r.productId, r.quantity]).sort();
const nothingHeld = async () => {
  assert.equal((await query('SELECT count(*)::int n FROM bookings'))[0].n, 0, 'no booking/hold created');
  assert.equal(fake.count('POST /orders'), 0, 'no payment order created');
};

// ---- A. GUEST → ACCOUNT MERGE ------------------------------------------------------------------

test('merge: guest cart (Premier ×2, Balcony ×1) into an empty account cart; nothing is held', { skip }, async () => {
  const premier = await makeShow({ price: 50000 });
  const balcony = await makeShow({ price: 25000 });
  const user = await makeUser();
  const result = await cart.mergeGuestCart(user.id, guest(), [{ productId: premier.productId, quantity: 2 }, { productId: balcony.productId, quantity: 1 }]);
  assert.equal(result.merged, true);
  assert.deepEqual(lines(result.lines), lines([{ productId: premier.productId, quantity: 2 }, { productId: balcony.productId, quantity: 1 }]));
  assert.ok(result.lines.every((l) => l.state === 'SELLABLE' && l.unitPrice > 0 && l.version === 1), 'server prices and state');
  await nothingHeld();
});

test('merge: guest cart joins an existing account cart; the same product is combined within the limits', { skip }, async () => {
  const a = await makeShow();
  const b = await makeShow();
  const user = await makeUser();
  await cart.saveAccountCart(user.id, [{ productId: a.productId, quantity: 2 }]);
  const result = await cart.mergeGuestCart(user.id, guest(), [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  assert.deepEqual(lines(result.lines), lines([{ productId: a.productId, quantity: 3 }, { productId: b.productId, quantity: 1 }]));
});

test('merge: quantity limits — never above the per-ticket maximum, the cart maximum or what is left', { skip }, async () => {
  const a = await makeShow({ allocation: 3 });
  const b = await makeShow();
  const user = await makeUser();
  await cart.saveAccountCart(user.id, [{ productId: a.productId, quantity: 2 }, { productId: b.productId, quantity: 3 }]);
  const result = await cart.mergeGuestCart(user.id, guest(), [{ productId: a.productId, quantity: 2 }, { productId: b.productId, quantity: 2 }]);
  const byId = Object.fromEntries(result.lines.map((l) => [l.productId, l.quantity]));
  assert.equal(byId[a.productId], 3, 'only 3 seats exist');
  assert.equal(byId[b.productId], 3, 'cart limit 6 reached');
  assert.equal(result.lines.reduce((n, l) => n + l.quantity, 0), cart.MAX_CART_TICKETS);
  assert.deepEqual(result.notices.map((n) => n.reason).sort(), ['LIMIT', 'REDUCED']);
  await assert.rejects(cart.saveAccountCart(user.id, [{ productId: a.productId, quantity: 7 }]), /valid ticket quantity/);
});

test('merge: sold-out, closed and removed/disabled products are reported, never added or held', { skip }, async () => {
  const soldOut = await makeShow({ allocation: 1 });
  const closed = await makeShow();
  const disabled = await makeShow();
  const ok = await makeShow();
  await query('UPDATE pools SET committed=1 WHERE id=$1', [soldOut.poolId]);
  await query("UPDATE shows SET status='DRAFT' WHERE id=$1", [closed.showId]);
  await query('UPDATE products SET enabled=false WHERE id=$1', [disabled.productId]);
  const user = await makeUser();
  const result = await cart.mergeGuestCart(user.id, guest(), [
    { productId: soldOut.productId, quantity: 1 }, { productId: closed.productId, quantity: 1 },
    { productId: disabled.productId, quantity: 1 }, { productId: randomUUID(), quantity: 1 }, { productId: ok.productId, quantity: 1 },
  ]);
  assert.deepEqual(lines(result.lines), lines([{ productId: ok.productId, quantity: 1 }]));
  assert.deepEqual(Object.fromEntries(result.notices.map((n) => [n.productId, n.reason])), {
    [soldOut.productId]: 'SOLD_OUT', [closed.productId]: 'CLOSED', [disabled.productId]: 'UNAVAILABLE',
    [result.notices.find((n) => ![soldOut.productId, closed.productId, disabled.productId].includes(n.productId))!.productId]: 'UNAVAILABLE',
  });
  await query('UPDATE pools SET committed=0 WHERE id=$1', [soldOut.poolId]);
  await nothingHeld();
});

test('merge: repeated sign-in callbacks and two tabs merge one guest cart exactly once', { skip }, async () => {
  const a = await makeShow();
  const user = await makeUser();
  const id = guest();
  const results = await Promise.all(Array.from({ length: 5 }, () => cart.mergeGuestCart(user.id, id, [{ productId: a.productId, quantity: 2 }])));
  assert.equal(results.filter((r) => r.merged).length, 1);
  await cart.mergeGuestCart(user.id, id, [{ productId: a.productId, quantity: 2 }]);
  assert.deepEqual(lines(await cart.readAccountCart(user.id)), lines([{ productId: a.productId, quantity: 2 }]), 'not 4, not 12');
});

test('merge: a season product merges like any line and covers its performances', { skip }, async () => {
  const s1 = await makeShow();
  const s2 = await makeShow({ startsInMinutes: 14 * 24 * 60 });
  const season = await makeSeason([s1, s2]);
  const user = await makeUser();
  const result = await cart.mergeGuestCart(user.id, guest(), [{ productId: season.productId, quantity: 1 }]);
  assert.equal(result.lines[0].kind, 'SEASON');
  assert.equal(result.lines[0].state, 'SELLABLE');
});

// ---- B. SURVIVES SIGN-OUT / EXPIRY; NEVER SHARED ----------------------------------------------------

test('account cart: survives sign-out and session expiry; another account never sees it; restored on sign-in', { skip }, async () => {
  const a = await makeShow();
  const userA = await makeUser();
  const userB = await makeUser();
  await cart.saveAccountCart(userA.id, [{ productId: a.productId, quantity: 2 }]);
  await query("INSERT INTO sessions(digest,user_id,expires_at) VALUES('sess-a',$1,now()+interval '1 hour')", [userA.id]);
  await query("DELETE FROM sessions WHERE user_id=$1", [userA.id]); // sign-out
  assert.deepEqual(await cart.readAccountCart(userB.id), [], 'account B (same device) sees nothing of A');
  await query("INSERT INTO sessions(digest,user_id,expires_at) VALUES('sess-a2',$1,now()-interval '1 minute')", [userA.id]); // expired session
  assert.deepEqual(lines(await cart.readAccountCart(userA.id)), lines([{ productId: a.productId, quantity: 2 }]), 'A gets the cart back');
  // B's merge of a guest cart never touches A's cart.
  await cart.mergeGuestCart(userB.id, guest(), [{ productId: a.productId, quantity: 1 }]);
  assert.deepEqual(lines(await cart.readAccountCart(userA.id)), lines([{ productId: a.productId, quantity: 2 }]));
});

test('account cart: saving keeps unchanged lines, drops removed ones, and paid lines leave it after confirmation', { skip }, async () => {
  const a = await makeShow();
  const b = await makeShow();
  const user = await makeUser();
  await cart.saveAccountCart(user.id, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]);
  const co = await checkout.createCheckout(user, [{ productId: a.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  await jobs.processJobs(); // DELIVERY: removes the paid line even if the browser never came back
  assert.deepEqual(lines(await cart.readAccountCart(user.id)), lines([{ productId: b.productId, quantity: 1 }]), 'only the unpaid line remains');
});

// ---- C. EXPIRY BY REAL SHOW TIMES --------------------------------------------------------------------

async function endShow(showId: string) {
  await query("UPDATE shows SET starts_at=now()-interval '3 hours', ends_at=now()-interval '1 hour' WHERE id=$1", [showId]);
}

test('expiry: an ended daily show leaves the cart; an upcoming one stays; a cancelled one leaves', { skip }, async () => {
  const ended = await makeShow();
  const upcoming = await makeShow();
  const cancelled = await makeShow();
  const user = await makeUser();
  await cart.saveAccountCart(user.id, [ended, upcoming, cancelled].map((s) => ({ productId: s.productId, quantity: 1 })));
  await endShow(ended.showId);
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [cancelled.showId]);
  assert.deepEqual(lines(await cart.readAccountCart(user.id)), lines([{ productId: upcoming.productId, quantity: 1 }]));
});

test('expiry: a season stays while ANY covered show is still ahead (first ended, later remains) and leaves only after the last', { skip }, async () => {
  const first = await makeShow();
  const last = await makeShow({ startsInMinutes: 20 * 24 * 60 });
  const season = await makeSeason([first, last]);
  const user = await makeUser();
  await cart.saveAccountCart(user.id, [{ productId: season.productId, quantity: 1 }]);
  await endShow(first.showId);
  const kept = await cart.readAccountCart(user.id);
  assert.equal(kept.length, 1, 'not removed because the first show ended');
  assert.equal(kept[0].state, 'CLOSED', 'but not purchasable: a season pass is sold only before its first show (existing rule)');
  await endShow(last.showId);
  assert.deepEqual(await cart.readAccountCart(user.id), [], 'removed after the final covered show');
});

test('expiry: scheduler cleanup removes ended lines for every account and never touches bookings or tickets', { skip }, async () => {
  const ended = await makeShow();
  const later = await makeShow({ startsInMinutes: 3 * 24 * 60 });
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [{ productId: ended.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(buyer, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, buyer);
  const users = [await makeUser(), await makeUser()];
  for (const u of users) await cart.saveAccountCart(u.id, [{ productId: ended.productId, quantity: 1 }, { productId: later.productId, quantity: 1 }]);
  await endShow(ended.showId);
  const summary = await jobs.processJobs();
  assert.equal(summary.cartLinesExpired, 2);
  assert.equal((await query('SELECT count(*)::int n FROM cart_items WHERE product_id=$1', [later.productId]))[0].n, 2, 'other lines kept');
  assert.equal((await query("SELECT count(*)::int n FROM bookings WHERE status='CONFIRMED'"))[0].n, 1, 'confirmed booking untouched');
  assert.equal((await query("SELECT count(*)::int n FROM tickets WHERE status='ACTIVE'"))[0].n, 1, 'ticket untouched');
});

test('expiry: checkout after a show ended or was cancelled is refused (server-side), nothing held', { skip }, async () => {
  const s = await makeShow();
  const user = await makeUser();
  await cart.saveAccountCart(user.id, [{ productId: s.productId, quantity: 1 }]);
  await query("UPDATE shows SET starts_at=now()-interval '10 minutes' WHERE id=$1", [s.showId]);
  await assert.rejects(checkout.createCheckout(user, [{ productId: s.productId, quantity: 1, version: 1 }], randomUUID()), /Sales for this performance have closed/);
  await nothingHeld();
});

