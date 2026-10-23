/**
 * Admin → Availability: daily-ticket sales controlled per performance (and per zone).
 *  - Closing one performance shows "Sales closed" (CLOSED, never SOLD_OUT) for it only; another
 *    performance and season tickets are untouched; the server refuses new holds; reopening sells again.
 *  - The admin view distinguishes Available, Sold out, Sales closed, Unavailable and Cancelled, with a reason.
 *  - A cancelled performance cannot be reopened; tickets already bought stay valid when sales close;
 *    inventory changes can never go below what is sold or held.
 * Real code on the local test database; Razorpay is the in-process fake.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, makeShow, makeUser, resetDatabase, useLiveStagingEnv as liveStagingEnv } from './helpers/fixtures';
import { performanceAvailability, zoneAvailability } from '../src/lib/availability';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let sales: typeof import('../src/lib/performance-sales');
let catalogue: typeof import('../src/lib/catalogue');
let commerce: typeof import('../src/lib/commerce');
let inventoryAdmin: typeof import('../src/lib/inventory-admin');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  liveStagingEnv();
  fake.install();
  sales = await import('../src/lib/performance-sales');
  catalogue = await import('../src/lib/catalogue');
  commerce = await import('../src/lib/commerce');
  inventoryAdmin = await import('../src/lib/inventory-admin');
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

const festivalId = async () => (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0].id;
const publicState = async (productId: string) => (await catalogue.publicProducts(await festivalId())).find((p) => p.id === productId);
const adminView = async (showId: string) => (await sales.performanceSalesOverview()).find((p) => p.id === showId)!;
const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });

test('Scenario A: closing one performance shows Sales closed for it only; holds are refused; reopening sells again', { skip }, async () => {
  const owner = await makeUser('owner');
  const one = await makeShow({ title: 'Night one' });
  const two = await makeShow({ title: 'Night two' });
  assert.equal((await publicState(one.productId))?.state, 'SELLABLE');
  assert.equal((await adminView(one.showId)).state, 'ON_SALE');

  const closed = await sales.setPerformanceSales(owner, one.showId, { open: false });
  assert.equal(closed.changed, 1);
  assert.deepEqual([(await publicState(one.productId))?.state, (await publicState(one.productId))?.available], ['CLOSED', 0], 'listed as closed, not hidden and not sold out');
  assert.equal((await publicState(two.productId))?.state, 'SELLABLE', 'another performance is unaffected');
  const view = await adminView(one.showId);
  assert.equal(view.state, 'SALES_CLOSED');
  assert.deepEqual([view.zones[0].state, view.zones[0].reason], ['SALES_CLOSED', 'Sales closed by an admin for this zone.']);
  await assert.rejects(commerce.reserve(await makeUser(), line(one), randomUUID()), /not available/, 'the server refuses, whatever the page shows');
  await commerce.reserve(await makeUser(), line(two), randomUUID());

  await sales.setPerformanceSales(owner, one.showId, { open: true });
  assert.equal((await publicState(one.productId))?.state, 'SELLABLE');
  await commerce.reserve(await makeUser(), line(one), randomUUID());
  assert.equal(Number((await query<{ v: number }>('SELECT version v FROM products WHERE id=$1', [one.productId]))[0].v), 1, 'price version unchanged: carts stay valid');
  const audits = await query<{ action: string }>("SELECT action FROM audit_events WHERE entity=$1 AND action LIKE 'show.sales.%' ORDER BY created_at", [one.showId]);
  assert.deepEqual(audits.map((a) => a.action), ['show.sales.close', 'show.sales.open']);
});

test('per-zone control changes only that zone; season tickets are never changed', { skip }, async () => {
  const owner = await makeUser('owner');
  const show = await makeShow();
  const balcony = (await query<{ id: string }>(
    `WITH cap AS (INSERT INTO capacities(show_id,zone,ceiling) VALUES($1,'Balcony',100) RETURNING id),
          pool AS (INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) SELECT id,'DAILY',20,1,5 FROM cap RETURNING id),
          prod AS (INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id) SELECT festival_id,'Balcony daily','ব্যালকনি','Balcony','DAILY',20000,id FROM shows WHERE id=$1 RETURNING id)
     INSERT INTO product_coverage(product_id,show_id,pool_id) SELECT prod.id,$1,pool.id FROM prod, pool RETURNING product_id id`, [show.showId]))[0];
  const season = (await query<{ id: string }>(`INSERT INTO products(festival_id,name,name_bn,category,kind,price) SELECT festival_id,'Season','মৌসুম','Premier','SEASON',100000 FROM shows WHERE id=$1 RETURNING id`, [show.showId]))[0];
  await sales.setPerformanceSales(owner, show.showId, { open: false, zone: 'Balcony' });
  assert.equal((await publicState(balcony.id))?.state, 'CLOSED');
  assert.equal((await publicState(show.productId))?.state, 'SELLABLE');
  await sales.setPerformanceSales(owner, show.showId, { open: false });
  assert.equal((await query<{ enabled: boolean }>('SELECT enabled FROM products WHERE id=$1', [season.id]))[0].enabled, true, 'season ticket untouched');
  await assert.rejects(sales.setPerformanceSales(owner, show.showId, { open: true, zone: 'Gallery' }), /Unknown zone/);
  await assert.rejects(sales.setPerformanceSales(owner, show.showId, { open: 'yes' }), /open or close/);
  await assert.rejects(sales.setPerformanceSales(owner, 'not-a-uuid', { open: true }), /not found/);
});

test('closing sales keeps bought tickets valid; a cancelled performance cannot be reopened', { skip }, async () => {
  const owner = await makeUser('owner');
  const show = await makeShow();
  const buyer = await makeUser();
  const hold = await commerce.reserve(buyer, line(show, 2), randomUUID());
  await query("UPDATE bookings SET status='CONFIRMED' WHERE id=$1", [hold.id]);
  await sales.setPerformanceSales(owner, show.showId, { open: false });
  assert.equal((await query<{ status: string }>('SELECT status FROM bookings WHERE id=$1', [hold.id]))[0].status, 'CONFIRMED');
  await query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [show.showId]);
  await assert.rejects(sales.setPerformanceSales(owner, show.showId, { open: true }), /cancelled/);
  const view = await adminView(show.showId);
  assert.equal(view.state, 'CANCELLED');
  assert.equal(view.zones[0].state, 'CANCELLED');
  assert.equal((await publicState(show.productId)), undefined, 'a cancelled performance is not listed for sale');
});

test('admin view: genuine sold out vs held seats, remaining and capacity; inventory never goes below what is sold or held', { skip }, async () => {
  const show = await makeShow({ allocation: 2 });
  await commerce.reserve(await makeUser(), line(show, 2), randomUUID());
  const z = (await adminView(show.showId)).zones[0];
  assert.deepEqual([z.state, z.remaining, z.held, z.allocation, z.ceiling], ['SOLD_OUT', 0, 2, 2, 500]);
  assert.match(z.reason, /2 held in checkouts/);
  assert.equal((await adminView(show.showId)).state, 'SOLD_OUT');
  assert.equal((await publicState(show.productId))?.state, 'SOLD_OUT');
  const cap = (await query<{ id: string; version: number }>("SELECT id, version FROM capacities WHERE show_id=$1", [show.showId]))[0];
  const owner = await makeUser('owner');
  await assert.rejects(inventoryAdmin.configureCapacity(owner, cap.id, { version: cap.version, ceiling: 500, seasonAllocation: 50, dailyAllocation: 1, onlineSeasonAllocation: 50 }));
  assert.equal(Number((await query<{ a: number }>("SELECT allocation a FROM pools WHERE id=$1", [show.poolId]))[0].a), 2);
});

test('zone states are distinct and explained (pure rules)', () => {
  const base = {
    showStatus: 'PUBLISHED', festivalStatus: 'PUBLISHED', startsAt: new Date(Date.now() + 864e5 * 3), productId: 'p', enabled: true,
    allocation: 10, held: 0, committed: 0, salesBlocked: null as string | null,
  };
  assert.equal(zoneAvailability(base).state, 'AVAILABLE');
  assert.equal(zoneAvailability({ ...base, committed: 10 }).state, 'SOLD_OUT');
  assert.equal(zoneAvailability({ ...base, enabled: false, committed: 10 }).state, 'SALES_CLOSED', 'closed wins over sold out');
  assert.match(zoneAvailability({ ...base, salesBlocked: 'Public sales are off.' }).reason, /Public sales are off/);
  assert.equal(zoneAvailability({ ...base, showStatus: 'DRAFT' }).state, 'SALES_CLOSED');
  assert.match(zoneAvailability({ ...base, bookingOpensAt: new Date(Date.now() + 864e5) }).reason, /Booking opens/);
  assert.match(zoneAvailability({ ...base, startsAt: new Date(Date.now() - 864e5) }).reason, /close time passed/);
  assert.equal(zoneAvailability({ ...base, productId: null }).state, 'UNAVAILABLE');
  assert.equal(zoneAvailability({ ...base, allocation: 0 }).state, 'UNAVAILABLE');
  assert.equal(zoneAvailability({ ...base, showStatus: 'CANCELLED' }).state, 'CANCELLED');
  const ends = new Date(Date.now() + 864e5);
  assert.equal(performanceAvailability({ status: 'PUBLISHED', ends_at: ends }, ['SOLD_OUT', 'AVAILABLE']), 'ON_SALE');
  assert.equal(performanceAvailability({ status: 'PUBLISHED', ends_at: ends }, ['SOLD_OUT', 'UNAVAILABLE']), 'SOLD_OUT');
  assert.equal(performanceAvailability({ status: 'PUBLISHED', ends_at: ends }, ['SALES_CLOSED']), 'SALES_CLOSED');
  assert.equal(performanceAvailability({ status: 'PUBLISHED', ends_at: ends }, ['SALES_CLOSED'], new Date(Date.now() + 864e5)), 'SCHEDULED');
  assert.equal(performanceAvailability({ status: 'DRAFT', ends_at: ends }, ['SALES_CLOSED']), 'DRAFT');
  assert.equal(performanceAvailability({ status: 'PUBLISHED', ends_at: new Date(Date.now() - 1000) }, []), 'ENDED');
});
