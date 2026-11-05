/**
 * Performance-card status tags (performance-status.ts) and the customer-facing name of the pass
 * (i18n.ts). Pure: no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEW_SEATS_MAX, performanceStatus } from '../src/lib/performance-status';
import { productDisplayName, t, ticketLineLabel, type MessageKey } from '../src/lib/i18n';

const NOW = Date.parse('2026-12-01T10:00:00Z');
const LATER = '2026-12-19T12:30:00.000Z';
const zone = (state: 'SELLABLE' | 'SOLD_OUT' | 'CLOSED', available: number, capacity: number | null = 100) => ({ state, available, capacity });

test('status tags follow the server sale state and seat counts, never anything else', () => {
  assert.equal(performanceStatus([zone('SELLABLE', 90), zone('SELLABLE', 80), zone('SELLABLE', 100)], LATER, NOW), 'AVAILABLE');
  // 60% or more of the online seats sold or held.
  assert.equal(performanceStatus([zone('SELLABLE', 40), zone('SELLABLE', 40), zone('SELLABLE', 40)], LATER, NOW), 'SELLING_FAST');
  assert.equal(performanceStatus([zone('SELLABLE', 41), zone('SELLABLE', 40), zone('SELLABLE', 40)], LATER, NOW), 'AVAILABLE');
  // Few seats: at most 10 left, or at most 10% of the online seats.
  assert.equal(performanceStatus([zone('SELLABLE', FEW_SEATS_MAX), zone('SOLD_OUT', 0)], LATER, NOW), 'FEW_SEATS');
  assert.equal(performanceStatus([zone('SELLABLE', 25, 300)], LATER, NOW), 'FEW_SEATS');
  // Sold out only when every zone still on sale is sold out; closed zones never count as available.
  assert.equal(performanceStatus([zone('SOLD_OUT', 0), zone('SOLD_OUT', 0), zone('CLOSED', 0)], LATER, NOW), 'SOLD_OUT');
  assert.equal(performanceStatus([zone('CLOSED', 0), zone('CLOSED', 0)], LATER, NOW), 'CLOSED');
  assert.equal(performanceStatus([], LATER, NOW), 'CLOSED');
  // The booking details stop daily sales once the performance has started: the card says so too.
  assert.equal(performanceStatus([zone('SELLABLE', 90)], '2026-12-01T09:59:00.000Z', NOW), 'CLOSED');
  // Without capacity figures only exact states and the absolute few-seats rule are used.
  assert.equal(performanceStatus([zone('SELLABLE', 11, null)], LATER, NOW), 'AVAILABLE');
  assert.equal(performanceStatus([zone('SELLABLE', 3, null)], LATER, NOW), 'FEW_SEATS');
});

test('every tag has English and Bengali text', () => {
  for (const key of ['perf.available', 'perf.sellingFast', 'perf.fewSeats', 'perf.soldOut', 'perf.closed'] as MessageKey[]) {
    assert.ok(t('en', key) && t('bn', key) && t('en', key) !== t('bn', key), key);
  }
  assert.deepEqual(['perf.available', 'perf.fewSeats', 'perf.sellingFast', 'perf.soldOut', 'perf.closed'].map((k) => t('en', k as MessageKey)),
    ['Available', 'Few Seats', 'Selling Fast', 'Sold Out', 'Booking Closed']);
});

test('the pass is called "All Together — Every Play" for customers, whatever its stored name', () => {
  assert.equal(productDisplayName('Premier Season', 'SEASON', 'Premier'), 'All Together — Every Play · Front block');
  assert.equal(productDisplayName('প্রিমিয়ার সিজন', 'SEASON', 'Balcony', 'bn'), `${t('bn', 'catalogue.seasonTitle')} · ${t('bn', 'zone.Balcony')}`);
  assert.ok(!/সিজন/.test(productDisplayName('প্রিমিয়ার সিজন', 'SEASON', 'Balcony', 'bn')));
  assert.equal(productDisplayName('Macbeth 2.0 – Premier', 'DAILY', 'Premier'), 'Macbeth 2.0 – Front block');
  assert.equal(ticketLineLabel('SEASON', 'Superior'), 'All Together · Second block');
  assert.equal(t('en', 'catalogue.seasonTitle'), 'All Together — Every Play');
});

test('no customer-facing message uses "Season" (English) or সিজন (Bengali)', () => {
  // privacy.s5 speaks of the festival season (the time of year), not the ticket.
  const allowed = new Set(['privacy.s5']);
  // Every message key, read from the English catalogue in the source (i18n.ts exports no key list).
  const source = readFileSync(new URL('../src/lib/i18n.ts', import.meta.url), 'utf8');
  const enBlock = source.slice(source.indexOf('const en: Dict = {'), source.indexOf('const bn: Dict = {'));
  const keys = [...enBlock.matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)].map((m) => m[1]);
  assert.ok(keys.length > 200, `found ${keys.length} keys`);
  for (const key of keys) {
    if (allowed.has(key)) continue;
    assert.ok(!/\bseasons?\b/i.test(t('en', key as MessageKey)), `en ${key}: ${t('en', key as MessageKey)}`);
    assert.ok(!/সিজন/.test(t('bn', key as MessageKey)), `bn ${key}`);
  }
});
