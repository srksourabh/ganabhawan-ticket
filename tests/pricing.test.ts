/**
 * Shared pricing, pure parts (pricing.ts, i18n.ts withZoneLabels, SeasonPrice.tsx): the All
 * together arithmetic, invalid configurations, the category display names, and that only the
 * original total is struck through. No database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discountPercent, seasonPricing, dailyPricingSnapshot } from '../src/lib/pricing';
import { dateLocale, ticketLineLabel, withZoneLabels, zoneLabel } from '../src/lib/i18n';
import { LocaleProvider } from '../src/components/LocaleProvider';
import SeasonPrice from '../src/components/SeasonPrice';
import { rupeesToPaise } from '../src/components/admin/PricingPanel';

test('categories: Premier, Superior and Balcony are shown as Front block, Second block and First floor', () => {
  assert.equal(zoneLabel('en', 'Premier'), 'Front block');
  assert.equal(zoneLabel('en', 'Superior'), 'Second block');
  assert.equal(zoneLabel('en', 'Balcony'), 'First floor');
  assert.equal(ticketLineLabel('SEASON', 'Premier'), 'All together · Front block');
  assert.equal(ticketLineLabel('DAILY', 'Balcony'), 'Daily ticket · First floor');
  // Stored product names (and older booking snapshots) keep the zone id; only the display changes.
  assert.equal(withZoneLabels('Macbeth 2.0 – Premier'), 'Macbeth 2.0 – Front block');
  assert.equal(withZoneLabels('Superior Season'), 'Second block Season');
  assert.equal(withZoneLabels('Balcony'), 'First floor');
  assert.equal(withZoneLabels('Macbeth – Premier', 'bn'), `Macbeth – ${zoneLabel('bn', 'Premier')}`);
  assert.equal(withZoneLabels('Premiere night'), 'Premiere night', 'whole words only');
  assert.equal(withZoneLabels(''), '');
});

test('All together: original = per-programme × programmes, saving and percentage (the three example zones)', () => {
  const cases = [
    { per: 50000, final: 400000, original: 600000, save: 200000, pct: 33.33 },
    { per: 35000, final: 300000, original: 420000, save: 120000, pct: 28.57 },
    { per: 25000, final: 220000, original: 300000, save: 80000, pct: 26.67 },
  ];
  for (const c of cases) {
    const p = seasonPricing({ perProgrammePrice: c.per, programmeCount: 12, finalPrice: c.final, configured: true });
    assert.equal(p.originalTotal, c.original);
    assert.equal(p.discountAmount, c.save);
    assert.equal(p.discountPercent, c.pct);
    assert.equal(p.finalPrice, c.final);
    assert.equal(p.showDiscount, true);
    assert.equal(p.blocked, false);
  }
  // ₹500 → ₹600: the original becomes ₹7,200 for 12 programmes; the final price is unchanged.
  const raised = seasonPricing({ perProgrammePrice: 60000, programmeCount: 12, finalPrice: 400000, configured: true });
  assert.deepEqual([raised.originalTotal, raised.discountAmount, raised.discountPercent], [720000, 320000, 44.44]);
  // The programme count is an input (never a constant).
  assert.equal(seasonPricing({ perProgrammePrice: 50000, programmeCount: 11, finalPrice: 400000, configured: true }).originalTotal, 550000);
});

test('All together: a final price above the original is blocked when configured; equal is valid with no discount', () => {
  const over = seasonPricing({ perProgrammePrice: 25000, programmeCount: 8, finalPrice: 220000, configured: true });
  assert.equal(over.blocked, true);
  assert.equal(over.showDiscount, false);
  assert.equal(over.discountAmount, 0);
  assert.match(over.problem!, /more than the original total ₹2,000/);
  const equal = seasonPricing({ perProgrammePrice: 25000, programmeCount: 8, finalPrice: 200000, configured: true });
  assert.deepEqual([equal.blocked, equal.showDiscount, equal.discountAmount, equal.discountPercent], [false, false, 0, 0]);
  // Not configured (derived from the daily tickets): shown, never enforced.
  assert.equal(seasonPricing({ perProgrammePrice: 25000, programmeCount: 8, finalPrice: 220000, configured: false }).blocked, false);
  // No programme or no per-programme price: no original, nothing blocked.
  assert.equal(seasonPricing({ perProgrammePrice: null, programmeCount: 12, finalPrice: 1, configured: false }).originalTotal, null);
  assert.equal(seasonPricing({ perProgrammePrice: 50000, programmeCount: 0, finalPrice: 1, configured: true }).blocked, false);
  assert.equal(discountPercent(1, 3), 33.33);
  assert.equal(discountPercent(0, 100), 0);
  assert.equal(discountPercent(10, 0), 0);
});

test('daily tickets: the snapshot carries the shared price and no discount', () => {
  assert.deepEqual(dailyPricingSnapshot('Premier', 50000, 3), {
    zone: 'Premier', zoneName: 'Front block', kind: 'DAILY', perProgrammePrice: 50000, programmeCount: 1,
    originalTotal: 50000, discountAmount: 0, discountPercent: 0, finalPrice: 50000, pricingVersion: 3,
  });
});

test('admin price input: rupees to paise, positive with at most two decimals', () => {
  assert.equal(rupeesToPaise('500'), 50000);
  assert.equal(rupeesToPaise(' 350.50 '), 35050);
  for (const bad of ['', '0', '-5', '1.234', 'abc', '5e3']) assert.equal(rupeesToPaise(bad), null, bad);
});

/** Server render as the site first paints (LocaleProvider starts in Bengali). */
function render(price: number, pricing?: ReturnType<typeof seasonPricing>) {
  return renderToStaticMarkup(createElement(LocaleProvider, null, createElement(SeasonPrice, { price, pricing })));
}

test('All together card: only the original total is struck through, never "price × programmes"', () => {
  const pricing = seasonPricing({ perProgrammePrice: 50000, programmeCount: 12, finalPrice: 400000, configured: true });
  const html = render(400000, pricing);
  const dl = dateLocale('bn');
  const money = (paise: number) => `₹${(paise / 100).toLocaleString(dl)}`;
  const struck = [...html.matchAll(/<s[ >][^]*?<\/s>/g)].map((m) => m[0]);
  assert.equal(struck.length, 1, html);
  assert.ok(struck[0].includes(money(600000)), struck[0]);
  assert.ok(!struck[0].includes('×'), 'the multiplication is not struck through');
  assert.ok(!struck[0].includes(money(50000)), 'the per-programme price is not struck through');
  const calc = html.match(/data-testid="season-calc">([^<]*)</)![1];
  assert.ok(calc.includes(money(50000)) && calc.includes('×'), calc);
  assert.ok(html.includes(money(200000)), 'shows the saving');
  assert.ok(html.match(/data-testid="season-final">([^<]*)</)![1] === money(400000));
  // Order: calculation, struck original, saving, final price.
  const at = (id: string) => html.indexOf(`data-testid="${id}"`);
  assert.ok(at('season-calc') < at('season-original') && at('season-original') < at('season-discount') && at('season-discount') < at('season-final'));
});

test('no saving, invalid configuration or no breakdown: the final price alone, nothing struck through', () => {
  for (const pricing of [
    undefined,
    seasonPricing({ perProgrammePrice: 25000, programmeCount: 8, finalPrice: 200000, configured: true }),
    seasonPricing({ perProgrammePrice: 25000, programmeCount: 8, finalPrice: 220000, configured: true }),
  ]) {
    const html = render(220000, pricing);
    assert.ok(!/<s[ >]/.test(html), html);
    assert.ok(!html.includes('×'), html);
    assert.ok(html.includes('data-testid="season-final"'));
  }
});
