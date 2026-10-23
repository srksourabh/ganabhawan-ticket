/**
 * Guest-checkout account takeover (fixed): a guest types a name, email and mobile, and nothing
 * proves the email is theirs. A guest session must never open the account behind that email
 * (booking history, tickets, QR codes, cart, details), never change it, and act only on the
 * checkout it created; it can still buy. Also covers the one-off revocation of sessions the
 * vulnerable code issued (db/maintenance/revoke-guest-sessions.sql).
 * Real auth, checkout and payment code on the local test database; Razorpay is the in-process fake.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let auth: typeof import('../src/lib/auth');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let attempts: typeof import('../src/lib/attempts');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  auth = await import('../src/lib/auth');
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  attempts = await import('../src/lib/attempts');
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
const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });
async function guest(name: string, mail: string, phone = '+919876500001', presented = '') {
  const opened = await auth.openGuestSession(name, mail, phone, presented);
  return { token: opened.sessionToken, user: (await auth.guestSessionUser(opened.sessionToken))!, reused: opened.reused };
}
async function payCheckout(user: User, checkoutId: string) {
  const order = await checkout.createCheckoutPaymentOrder(user, checkoutId);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
}

// ---- GUEST SESSIONS NEVER OPEN AN ACCOUNT ------------------------------------------------------------

test('guest session for an existing customer\'s email: no account access, no change to the account', { skip }, async () => {
  const owner = await makeUser('customer', 'owner@tickets.test', { mobile: null });
  await query("UPDATE users SET name='Real Owner' WHERE id=$1", [owner.id]);
  const show = await makeShow();
  const ownerCo = await checkout.createCheckout(owner, [line(show)], randomUUID());
  const g = await guest('Impostor', 'OWNER@tickets.test', '+919876500002');
  assert.ok(g.token.startsWith(auth.GUEST_TOKEN_PREFIX));
  assert.equal(await auth.sessionUser(g.token), null, 'the guest token is NOT an account session');
  assert.equal(g.user.id, owner.id, 'bookings still belong to the email\'s customer record');
  assert.ok(g.user.guestSince);
  assert.equal((await query<{ name: string }>('SELECT name FROM users WHERE id=$1', [owner.id]))[0].name, 'Real Owner', 'name not overwritten');
  // By-id access only to what the guest session created.
  await assert.rejects(auth.assertBuyerScope(g.user, ownerCo.id), /Not found/);
  await assert.rejects(auth.assertBuyerScope(g.user, ownerCo.bookings[0].id), /Not found/);
  await assert.rejects(auth.assertBuyerScope(g.user, randomUUID()), /Not found/);
  await assert.rejects(auth.assertBuyerScope(g.user, 'not-a-uuid'), /Not found/);
  await auth.assertBuyerScope(owner, ownerCo.id); // signed-in customers are unaffected
  // A guest checkout never supersedes or reuses the account owner's own open checkout.
  const guestCo = await checkout.createCheckout(g.user, [line(show)], randomUUID());
  assert.notEqual(guestCo.id, ownerCo.id);
  assert.equal(await count("SELECT count(*)::int n FROM bookings WHERE checkout_id=$1 AND status='HELD'", [ownerCo.id]), 1, 'owner hold untouched');
  await auth.assertBuyerScope(g.user, guestCo.id);
});

test('guest sessions: staff emails refused; the same guest reuses its session; invalid details refused', { skip }, async () => {
  await makeUser('owner', 'boss@tickets.test');
  await assert.rejects(auth.openGuestSession('X', 'boss@tickets.test', '+919876500003'), /personal email/);
  await assert.rejects(auth.openGuestSession('', 'a@tickets.test', '+919876500003'), /name/);
  await assert.rejects(auth.openGuestSession('A', 'not-an-email', '+919876500003'));
  await assert.rejects(auth.openGuestSession('A', 'a@tickets.test', 'a@tickets.test'), /mobile/);
  const first = await guest('A', 'a@tickets.test');
  const again = await guest('A', 'a@tickets.test', '+919876500001', first.token);
  assert.equal(again.reused, true);
  assert.equal(again.token, first.token);
  const other = await guest('B', 'b@tickets.test', '+919876500004', first.token);
  assert.equal(other.reused, false, 'a different guest gets its own session');
  assert.notEqual(other.user.id, first.user.id);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE action='auth.guest'"), 2);
  // Account tokens never look like guest tokens.
  const staffSession = await auth.verifyOtp(...(await (async () => {
    const r = await auth.requestOtp('c@tickets.test', '10.30.0.1');
    return [r.challengeId, /code is (\d{6})/.exec(fake.emails.at(-1)!.text)![1]] as const;
  })()));
  assert.ok(!staffSession.sessionToken!.startsWith(auth.GUEST_TOKEN_PREFIX));
});

test('a guest still buys end to end; the booking is the email customer\'s, under the guest session only', { skip }, async () => {
  const show = await makeShow();
  const g = await guest('Guest Buyer', 'buyer@tickets.test', '+919876500020');
  const attempt = await attempts.recordBookingAttempt({ name: 'Guest Buyer', email: 'buyer@tickets.test', phone: '+919876500020', contact: 'buyer@tickets.test', productId: show.productId, quantity: 2, userId: g.user.id });
  const co = await checkout.createCheckout(g.user, [line(show, 2)], randomUUID());
  await attempts.linkAttempt(String((attempt as { id: string }).id), g.user.id, g.user.contact, co.bookings[0].id, 'HELD');
  await auth.assertBuyerScope(g.user, co.id);
  await payCheckout(g.user, co.id);
  assert.equal((await checkout.checkoutReceipt(g.user.id, co.id)).status, 'CONFIRMED');
  assert.equal(await count("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND t.status='ACTIVE'", [co.id]), 2);
  assert.equal((await query<{ holder_name: string }>('SELECT holder_name FROM bookings WHERE checkout_id=$1', [co.id]))[0].holder_name, 'Guest Buyer');
});

test('revoke-guest-sessions.sql ends every session the guest checkout created and no other session', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const { transaction } = await import('../src/lib/db');
  const { hash } = await import('../src/lib/security');
  const victim = await makeUser('customer', 'victim@tickets.test', { mobile: null });
  // A session issued by the VULNERABLE code: an ordinary account token + 'auth.guest' audit, one transaction.
  const legacy = 'legacy-guest-token-' + randomUUID();
  await transaction(async (c) => {
    await c.query("INSERT INTO sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hash(legacy), victim.id]);
    await c.query("INSERT INTO audit_events(actor_id,action,entity) VALUES($1,'auth.guest',$2)", [victim.id, victim.id]);
  });
  assert.equal((await auth.sessionUser(legacy))?.id, victim.id, 'the legacy guest session opened the account');
  // The victim's own sign-in (not a guest checkout) must survive.
  const own = await auth.requestOtp('victim@tickets.test', '10.40.0.1');
  const mine = await auth.verifyOtp(own.challengeId, /code is (\d{6})/.exec(fake.emails.at(-1)!.text)![1]);
  const fixed = await guest('Guest', 'other@tickets.test', '+919876500021');
  await query(readFileSync('db/maintenance/revoke-guest-sessions.sql', 'utf8'));
  assert.equal(await auth.sessionUser(legacy), null, 'legacy guest session ended');
  assert.equal(await auth.guestSessionUser(fixed.token), null, 'current guest checkout sessions end too');
  assert.equal((await auth.sessionUser(mine.sessionToken!))?.id, victim.id, 'the account owner\'s own session is kept');
});
