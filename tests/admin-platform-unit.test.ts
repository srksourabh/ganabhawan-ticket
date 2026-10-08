/**
 * Pure rules behind the admin platform, availability and cart isolation.
 * No database, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { salesOpen, sellState } from '../src/lib/availability';
import { validateCapacityConfig } from '../src/lib/inventory-admin';
import { ACCOUNT_CART_PING_KEY, GUEST_CART_KEY, cleanupStaleCartStorage, forgetAccountLocally, guestCartId, pendingKey, readGuestItems, resetGuestCart, writeGuestItems, type CartStorage } from '../src/lib/cart-storage';
import { ADMIN_POLICY } from '../src/lib/admin-policy';
import { AppError } from '../src/lib/errors';
import { DEFAULT_SMS_TEXT, msg91Payload, renderSms } from '../src/lib/sms';
import type { Role, User } from '../src/lib/types';

const NOW = Date.parse('2026-12-01T12:00:00Z');
const future = '2026-12-19T13:00:00Z';
const past = '2026-11-30T13:00:00Z';
const pool = (status: string, starts_at: string, left = 10) => ({ status, starts_at, allocation: left, held: 0, committed: 0 });

// ---- AVAILABILITY: one rule for catalogue and hold -------------------------------------------

test('availability: a season with every covered show published and upcoming is sellable', () => {
  assert.deepEqual(sellState([pool('PUBLISHED', future), pool('PUBLISHED', future, 3)], null, 0, NOW), { state: 'SELLABLE', available: 3 });
});

test('availability: one covered show started, draft or cancelled closes the WHOLE season (same as placeHold)', () => {
  for (const bad of [pool('PUBLISHED', past), pool('DRAFT', future), pool('CANCELLED', future)]) {
    assert.equal(salesOpen([pool('PUBLISHED', future), bad], NOW), false);
    assert.deepEqual(sellState([pool('PUBLISHED', future), bad], null, 0, NOW), { state: 'CLOSED', available: 0 });
  }
  assert.equal(salesOpen([], NOW), false, 'no coverage is never sellable');
});

test('availability: the scarcest pool and the product cap decide; zero left is SOLD_OUT, not CLOSED', () => {
  assert.deepEqual(sellState([pool('PUBLISHED', future, 0)], null, 0, NOW), { state: 'SOLD_OUT', available: 0 });
  assert.deepEqual(sellState([pool('PUBLISHED', future, 50)], 20, 19, NOW), { state: 'SELLABLE', available: 1 });
  assert.deepEqual(sellState([pool('PUBLISHED', future, 50)], 20, 20, NOW), { state: 'SOLD_OUT', available: 0 });
});

// ---- INVENTORY: allocation invariants ----------------------------------------------------------

const none = { daily: 0, season: 0 };

test('inventory: 300 total / 50 season / 250 daily / 20 online season is valid', () => {
  assert.deepEqual(validateCapacityConfig({ ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 20 }, none),
    { ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 20 });
});

test('inventory: unsafe allocations are rejected with a clear server error', () => {
  const bad = (input: Record<string, unknown>, used = none, pattern: RegExp) =>
    assert.throws(() => validateCapacityConfig(input, used), (e: unknown) => e instanceof AppError && pattern.test(e.message));
  bad({ ceiling: 300, seasonAllocation: 51, dailyAllocation: 250, onlineSeasonAllocation: 20 }, none, /cannot exceed the zone capacity/);
  bad({ ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 51 }, none, /cannot exceed the season allocation/);
  bad({ ceiling: 300, seasonAllocation: 50, dailyAllocation: 100, onlineSeasonAllocation: 20 }, { daily: 120, season: 0 }, /cannot go below 120/);
  bad({ ceiling: 300, seasonAllocation: 50, dailyAllocation: 250, onlineSeasonAllocation: 5 }, { daily: 0, season: 6 }, /cannot go below 6/);
  bad({ ceiling: -1, seasonAllocation: 0, dailyAllocation: 0, onlineSeasonAllocation: 0 }, none, /whole number/);
  bad({ ceiling: 10.5, seasonAllocation: 0, dailyAllocation: 0, onlineSeasonAllocation: 0 }, none, /whole number/);
});

// ---- CART: the browser keeps only the guest cart ---------------------------------------------

function memory(): CartStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null, get length() { return map.size; },
  };
}
const item = (productId: string) => ({ productId, quantity: 1 });

test('cart storage: only the guest cart and its merge id live in the browser; merging resets both', () => {
  const s = memory();
  writeGuestItems(s, [item('guest-pick')]);
  const id = guestCartId(s);
  assert.equal(guestCartId(s), id, 'stable until merged');
  assert.deepEqual(readGuestItems(s), [item('guest-pick')]);
  resetGuestCart(s);
  assert.deepEqual(readGuestItems(s), []);
  assert.notEqual(guestCartId(s), id, 'a new guest cart after a merge');
  assert.ok([...s.map.keys()].every((k) => k === 'samatat-cart:guest-id'), 'no account cart is ever stored');
});

test('cart storage: stale browser data — old per-account carts are deleted, the old unowned cart becomes the guest cart', () => {
  const s = memory();
  s.setItem('samatat-cart', JSON.stringify([item('legacy')]));
  s.setItem('samatat-cart:user:account-a', JSON.stringify([item('a-private')]));
  s.setItem('samatat-pending-checkout', '{}');
  cleanupStaleCartStorage(s);
  assert.deepEqual(readGuestItems(s), [item('legacy')]);
  assert.equal(s.getItem('samatat-cart:user:account-a'), null, 'another account’s old cart is never shown');
  assert.equal(s.getItem('samatat-cart'), null);
  assert.equal(s.getItem('samatat-pending-checkout'), null);
});

test('cart storage: sign-out removes only the account’s pending-checkout note; the cross-tab ping carries no content', () => {
  const s = memory();
  s.setItem(pendingKey('user-a')!, JSON.stringify({ id: 'co', reference: 'GC', lines: [] }));
  writeGuestItems(s, [item('guest-pick')]);
  forgetAccountLocally(s, 'user-a');
  assert.equal(s.getItem(pendingKey('user-a')!), null);
  assert.deepEqual(readGuestItems(s), [item('guest-pick')]);
  assert.equal(pendingKey(null), null, 'guests have no pending checkout (checkout needs an account)');
  assert.equal(GUEST_CART_KEY, 'samatat-cart:guest');
  assert.equal(ACCOUNT_CART_PING_KEY, 'samatat-cart:changed');
});

// ---- ADMIN: server-side authorization ----------------------------------------------------------

test('admin: role policy — customers and gate staff are refused every admin area; only the owner manages staff', async () => {
  const { assertRole } = await import('../src/lib/auth');
  const as = (role: Role) => ({ id: 'u', contact: 'x@y.z', name: '', role }) as User;
  const allowed = (role: Role, area: keyof typeof ADMIN_POLICY) => { try { assertRole(as(role), ADMIN_POLICY[area]); return true; } catch (e) { assert.ok(e instanceof AppError && e.status === 403); return false; } };
  for (const area of Object.keys(ADMIN_POLICY) as (keyof typeof ADMIN_POLICY)[]) {
    assert.equal(allowed('customer', area), false, `customer → ${area}`);
    assert.equal(allowed('scanner', area), false, `scanner → ${area}`);
    assert.equal(allowed('supervisor', area), false, `supervisor → ${area}`);
    assert.equal(allowed('owner', area), true, `owner → ${area}`);
  }
  assert.equal(allowed('inventory', 'staff'), false);
  assert.equal(allowed('finance', 'inventory'), false);
  assert.equal(allowed('finance', 'metrics'), true);
});

test('admin: every admin API handler authenticates server-side before doing anything', () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (name === 'route.ts') files.push(p); } };
  walk(join(import.meta.dirname, '..', 'app', 'api', 'admin'));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const handlers = source.match(/export async function (GET|POST|PATCH|PUT|DELETE)/g) ?? [];
    const guards = (source.match(/await authenticated\(/g) ?? []).length + (source.match(/await currentUser\(\)/g) ?? []).length;
    assert.ok(guards >= handlers.length, `${file}: ${handlers.length} handler(s) but ${guards} auth check(s)`);
  }
});

test('refund policy: no customer-facing route can cancel or refund a booking', () => {
  for (const dir of ['bookings', 'tickets', 'checkouts', 'holds', 'booking-attempts']) {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : n === 'route.ts' ? [p] : []; });
    for (const file of walk(join(import.meta.dirname, '..', 'app', 'api', dir))) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /export async function DELETE/, `${file} exposes DELETE`);
      assert.doesNotMatch(source, /executeRefund|refundCase|cancelShowSales|INSERT INTO refunds/, `${file} can start a refund`);
    }
  }
});

// ---- SMS: configurable text and MSG91 variables --------------------------------------------------

const values = { REFERENCE: 'GC-1A2B', SHOW: 'Raktakarabi', LINK: 'https://t.example/tickets', NAME: 'Asha' };

test('sms: default wording, and SMS_CONFIRMATION_TEXT replaces it exactly (only {REFERENCE} {SHOW} {LINK} {NAME})', () => {
  assert.equal(renderSms(values).text, DEFAULT_SMS_TEXT.replace('{REFERENCE}', 'GC-1A2B').replace('{SHOW}', 'Raktakarabi').replace('{LINK}', 'https://t.example/tickets'));
  process.env.SMS_CONFIRMATION_TEXT = 'Booking {REFERENCE} for {SHOW} confirmed. {LINK} -{NAME} {UNKNOWN}';
  assert.equal(renderSms(values).text, 'Booking GC-1A2B for Raktakarabi confirmed. https://t.example/tickets -Asha {UNKNOWN}');
  delete process.env.SMS_CONFIRMATION_TEXT;
  assert.ok(renderSms({ ...values, SHOW: 'A very long programme name that exceeds DLT limits' }).variables.SHOW.length <= 30, 'DLT variables stay short');
});

test('sms: MSG91 payload — flow template id, number without "+", variables mapped to the approved template names', () => {
  process.env.MSG91_TEMPLATE_ID = 'tmpl-1';
  process.env.MSG91_SENDER_ID = 'SAMTAT';
  process.env.MSG91_TEMPLATE_VARIABLES = 'var1=REFERENCE, var2=SHOW, var3=LINK, bogus=NOT_A_VALUE';
  assert.deepEqual(msg91Payload('+919876543210', renderSms(values)), {
    template_id: 'tmpl-1', short_url: '0', sender: 'SAMTAT',
    recipients: [{ mobiles: '919876543210', var1: 'GC-1A2B', var2: 'Raktakarabi', var3: 'https://t.example/tickets' }],
  });
  delete process.env.MSG91_TEMPLATE_VARIABLES;
  assert.deepEqual(Object.keys(renderSms(values).variables), ['REFERENCE', 'SHOW', 'LINK'], 'default mapping');
  delete process.env.MSG91_TEMPLATE_ID;
  delete process.env.MSG91_SENDER_ID;
});
