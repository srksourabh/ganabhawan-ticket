/**
 * Sales gates at checkout, independent of the time of day the suite runs.
 * Root cause of 15 CI failures ("Sales for this performance have closed", checkout.ts lineError):
 * the show fixture left sales_closes_at NULL, so the production default applied (daily sales close
 * at 7pm IST on the show's calendar day); a show starting within the hour was already closed
 * whenever the suite ran after 19:00 IST (13:30 UTC). The fixture now sets the close explicitly.
 * These tests pin both: fixtures are open by construction, and every real gate still closes.
 * Real checkout code on the local test database.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, makeSeason, makeShow, makeUser, resetDatabase, useLiveStagingEnv as liveStagingEnv } from './helpers/fixtures';
import { defaultDailyClose, salesOpen } from '../src/lib/availability';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let checkout: typeof import('../src/lib/checkout');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  liveStagingEnv();
  fake.install();
  checkout = await import('../src/lib/checkout');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  liveStagingEnv();
  fake.reset();
  await resetDatabase();
});

const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });
const buy = async (p: { productId: string }, quantity = 1) => checkout.createCheckout(await makeUser(), [line(p, quantity)], randomUUID());

test('the production rule is unchanged: with no explicit close, daily sales stop at 7pm IST on the show day (fixed clock)', () => {
  // 19:17 IST on 23 Oct 2026 (the CI failure time), show at 19:47 IST the same evening.
  const now = Date.parse('2026-10-23T13:47:00Z');
  const startsAt = '2026-10-23T14:17:00Z';
  const show = { status: 'PUBLISHED', starts_at: startsAt, allocation: 10, held: 0, committed: 0 };
  assert.equal(defaultDailyClose(startsAt).toISOString(), '2026-10-23T13:30:00.000Z');
  assert.equal(salesOpen([show], now, { kind: 'DAILY' }), false, 'default close (19:00 IST) already passed');
  assert.equal(salesOpen([{ ...show, sales_closes_at: '2026-10-23T16:17:00Z' }], now, { kind: 'DAILY' }), true, 'an explicit later close keeps it open');
  assert.equal(salesOpen([show], Date.parse('2026-10-23T12:00:00Z'), { kind: 'DAILY' }), true, 'before 19:00 IST it is open');
});

test('fixture shows are on sale at any time of day: a show starting in 30 minutes checks out', { skip }, async () => {
  const soon = await makeShow({ startsInMinutes: 30 });
  const row = (await query<{ sales_closes_at: Date; ends_at: Date }>('SELECT sales_closes_at, ends_at FROM shows WHERE id=$1', [soon.showId]))[0];
  assert.equal(new Date(row.sales_closes_at).getTime(), new Date(row.ends_at).getTime(), 'the close is explicit, not the 7pm default');
  const co = await buy(soon, 2);
  assert.equal(co.status, 'HELD');
  const season = (await query<{ season_closes_at: Date }>('SELECT season_closes_at FROM festivals LIMIT 1'))[0];
  assert.ok(new Date(season.season_closes_at).getTime() > Date.now() + 300 * 864e5, 'festival season close explicit, not a calendar default');
});

test('a fixture show that keeps the production default follows the 7pm IST rule whatever the clock says', { skip }, async () => {
  const show = await makeShow({ startsInMinutes: 30, salesClosesAt: null });
  const starts = (await query<{ starts_at: Date }>('SELECT starts_at FROM shows WHERE id=$1', [show.showId]))[0].starts_at;
  const open = Date.now() < defaultDailyClose(starts).getTime();
  if (open) assert.equal((await buy(show)).status, 'HELD');
  else await assert.rejects(buy(show), /Sales for this performance have closed/);
});

test('performance-level gates still close: close time passed, draft, cancelled, admin "On sale" off', { skip }, async () => {
  const past = await makeShow({ salesClosesAt: new Date(Date.now() - 60_000) });
  await assert.rejects(buy(past), /Sales for this performance have closed/);
  const draft = await makeShow();
  await query("UPDATE shows SET status='DRAFT' WHERE id=$1", [draft.showId]);
  await assert.rejects(buy(draft), /closed/);
  const cancelled = await makeShow();
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [cancelled.showId]);
  await assert.rejects(buy(cancelled), /closed/);
  const off = await makeShow();
  await query('UPDATE products SET enabled=false WHERE id=$1', [off.productId]);
  await assert.rejects(buy(off), /not available/);
  assert.equal(Number((await query<{ n: number }>("SELECT count(*)::int n FROM bookings"))[0].n), 0, 'nothing held');
});

test('festival-level gates still close: booking not open yet, festival paused, public sales off, season close passed', { skip }, async () => {
  const show = await makeShow();
  await query("UPDATE festivals SET booking_opens_at=now()+interval '1 day'");
  await assert.rejects(buy(show), /closed/);
  await query('UPDATE festivals SET booking_opens_at=NULL');
  await query("UPDATE festivals SET status='PAUSED'");
  await assert.rejects(buy(show), /paused/);
  await query("UPDATE festivals SET status='PUBLISHED'");
  process.env.ALLOW_PUBLIC_SALES = 'false';
  await assert.rejects(buy(show), /paused|not open|not configured/i);
  process.env.ALLOW_PUBLIC_SALES = 'true';
  const later = await makeShow({ startsInMinutes: 3 * 24 * 60 });
  const season = await makeSeason([later]);
  assert.equal((await buy(season)).status, 'HELD', 'season open with the explicit close');
  await query("UPDATE festivals SET season_closes_at=now()-interval '1 minute'");
  await assert.rejects(buy(season), /closed/);
  assert.equal((await buy(show)).status, 'HELD', 'daily tickets do not depend on the season close');
});

test('inventory and ownership checks are unchanged: no oversell, no ordering on another customer\'s checkout', { skip }, async () => {
  const show = await makeShow({ allocation: 2 });
  await assert.rejects(buy(show, 3), /Not enough tickets remain/);
  const owner = await makeUser();
  const co = await checkout.createCheckout(owner, [line(show, 2)], randomUUID());
  await assert.rejects(buy(show, 1), /Not enough tickets remain/, 'the held seats are not sold twice');
  await assert.rejects(checkout.createCheckoutPaymentOrder(await makeUser(), co.id), /Checkout not found/);
});
