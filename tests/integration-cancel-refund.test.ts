/**
 * DB-backed show cancellation, gate behaviour around it, and the refund
 * state machine (provider-confirmed, idempotent under concurrency/crash).
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, booking, checkoutSignature, makeSeason, makeShow, makeUser, pool, resetDatabase, useLiveStagingEnv, webhook } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let catalogue: typeof import('../src/lib/catalogue');
let refunds: typeof import('../src/lib/refunds');
let jobs: typeof import('../src/lib/jobs');
let admission: typeof import('../src/lib/admission');
let staff: typeof import('../src/lib/staff');
let security: typeof import('../src/lib/security');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  catalogue = await import('../src/lib/catalogue');
  refunds = await import('../src/lib/refunds');
  jobs = await import('../src/lib/jobs');
  admission = await import('../src/lib/admission');
  staff = await import('../src/lib/staff');
  security = await import('../src/lib/security');
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

async function buy(user: User, productId: string, quantity = 1) {
  const h = (await commerce.reserve(user, { productId, quantity, version: 1 }, randomUUID())) as { id: string };
  const order = await payments.createPaymentOrder(user, h.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return { bookingId: h.id, paymentId: p.id };
}

async function tokenOf(bookingId: string) {
  const row = (await query<{ encrypted_token: string }>(
    "SELECT c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id WHERE t.booking_id=$1 ORDER BY t.ordinal LIMIT 1",
    [bookingId],
  ))[0];
  return security.decrypt(row.encrypted_token);
}

async function scanner() {
  const s = await staff.upsertStaff({ contact: `scan-${randomUUID().slice(0, 6)}@tickets.test`, role: 'scanner' });
  return { id: s.id, contact: s.contact, name: '', role: 'scanner' as const };
}

const scan = (who: User, showId: string, token: string) =>
  admission.admit(who, { requestId: randomUUID(), ticketToken: token, showId, gateId: 'gate-one', deviceId: 'gate-one' });

const cancel = (owner: User, showId: string) => catalogue.updateShow(owner, showId, { status: 'CANCELLED', confirmCancellation: true });

test('show cancellation: tickets voided, gate refuses them, bookings cancelled, refunded once, customers notified', { skip }, async () => {
  const show = await makeShow({ allocation: 10, startsInMinutes: 30 });
  const owner = await makeUser('owner');
  const a = await makeUser();
  const b = await makeUser();
  const held = await makeUser();
  const ba = await buy(a, show.productId, 2);
  const bb = await buy(b, show.productId, 1);
  const hold = (await commerce.reserve(held, { productId: show.productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  const door = await scanner();

  // Before cancellation the gate admits a valid ticket.
  assert.equal((await scan(door, show.showId, await tokenOf(ba.bookingId))).result, 'ADMITTED');
  const tokenB = await tokenOf(bb.bookingId);

  await cancel(owner, show.showId);

  for (const id of [ba.bookingId, bb.bookingId, hold.id]) assert.equal((await booking(id)).status, 'CANCELLED');
  assert.deepEqual(await pool(show.poolId), { allocation: 10, held: 0, committed: 0 });
  assert.equal((await query("SELECT count(*)::int n FROM credentials WHERE status='ACTIVE'"))[0].n, 0);
  assert.equal((await query("SELECT count(*)::int n FROM entitlements WHERE status='ACTIVE'"))[0].n, 0);
  assert.equal((await scan(door, show.showId, tokenB)).result, 'DENIED', 'gate refuses a cancelled show');
  assert.equal((await query('SELECT count(*)::int n FROM refunds'))[0].n, 2, 'one refund per paid booking, none for the unpaid hold');

  // Duplicate cancellation request is a no-op.
  await cancel(owner, show.showId);
  assert.equal((await query('SELECT count(*)::int n FROM refunds'))[0].n, 2);

  await jobs.processJobs();
  assert.equal(fake.refunds.size, 2);
  assert.deepEqual([...fake.refunds.values()].map((r) => r.amount).sort(), [show.price, show.price * 2].sort());
  assert.equal((await query("SELECT count(*)::int n FROM refunds WHERE state='SUCCEEDED'"))[0].n, 2);
  const notices = fake.emails.filter((e) => /Booking update/.test(e.subject)).map((e) => e.to);
  for (const user of [a, b, held]) assert.ok(notices.includes(user.contact), 'each affected customer was notified');
  assert.ok((await query("SELECT count(*)::int n FROM audit_events WHERE action='show.cancel.booking'"))[0].n >= 3);
});

test('cancellation is owner-only, needs explicit confirmation, and is final', { skip }, async () => {
  const show = await makeShow();
  const owner = await makeUser('owner');
  const inventory = await makeUser('inventory');
  await assert.rejects(() => catalogue.updateShow(inventory, show.showId, { status: 'CANCELLED', confirmCancellation: true }), /Only the owner/);
  await assert.rejects(() => catalogue.updateShow(owner, show.showId, { status: 'CANCELLED' }), /Confirm the cancellation/);
  await cancel(owner, show.showId);
  await assert.rejects(() => catalogue.updateShow(owner, show.showId, { status: 'PUBLISHED' }), /final/);
});

test('unpublishing a show with sold tickets is refused (would strand paid customers)', { skip }, async () => {
  const show = await makeShow();
  const owner = await makeUser('owner');
  await buy(await makeUser(), show.productId);
  await assert.rejects(() => catalogue.updateShow(owner, show.showId, { status: 'DRAFT' }), /Cancel it/);
});

test('season bookings block cancellation instead of leaving a half-refund (D14 pending)', { skip }, async () => {
  const s1 = await makeShow();
  const s2 = await makeShow();
  const season = await makeSeason([s1, s2]);
  const owner = await makeUser('owner');
  const pass = await buy(await makeUser(), season.productId);
  await assert.rejects(() => cancel(owner, s1.showId), /season booking/);
  assert.equal((await query("SELECT status FROM shows WHERE id=$1", [s1.showId]))[0].status, 'PUBLISHED');
  assert.equal((await booking(pass.bookingId)).status, 'CONFIRMED');
});

test('10 concurrent executions of one refund create exactly one provider refund', { skip }, async () => {
  const show = await makeShow();
  const b = await buy(await makeUser(), show.productId);
  const owner = await makeUser('owner');
  await cancel(owner, show.showId);
  const refundId = (await query<{ id: string }>('SELECT id FROM refunds WHERE booking_id=$1', [b.bookingId]))[0].id;
  fake.latencyMs = 30;
  await Promise.allSettled(Array.from({ length: 10 }, () => refunds.executeRefund(refundId)));
  assert.equal(fake.refunds.size, 1);
  assert.equal(fake.count('POST /payments/:id/refund'), 1);
});

test('crash after the provider accepted a refund: retry adopts it instead of refunding again', { skip }, async () => {
  const show = await makeShow();
  const b = await buy(await makeUser(), show.productId);
  await cancel(await makeUser('owner'), show.showId);
  const refundId = (await query<{ id: string }>('SELECT id FROM refunds WHERE booking_id=$1', [b.bookingId]))[0].id;
  // Simulate: provider created it (with our note), worker died before writing the DB.
  fake.refunds.set('rfnd_crash000000001', { id: 'rfnd_crash000000001', payment_id: b.paymentId, amount: show.price, status: 'processed', notes: { refundId } });
  await query("UPDATE jobs SET state='RUNNING', locked_at=now() - interval '30 minutes' WHERE kind='REFUND'");
  await jobs.processJobs();
  assert.equal(fake.refunds.size, 1);
  const row = (await query('SELECT state, provider_refund_id FROM refunds WHERE id=$1', [refundId]))[0];
  assert.deepEqual(row, { state: 'SUCCEEDED', provider_refund_id: 'rfnd_crash000000001' });
});

test('pending refund stays PROCESSING (not SUCCEEDED) until the provider confirms', { skip }, async () => {
  const show = await makeShow();
  const b = await buy(await makeUser(), show.productId);
  await cancel(await makeUser('owner'), show.showId);
  fake.refundStatus = 'pending';
  await jobs.processJobs();
  const r = (await query<{ id: string; state: string; provider_refund_id: string }>('SELECT id, state, provider_refund_id FROM refunds WHERE booking_id=$1', [b.bookingId]))[0];
  assert.equal(r.state, 'PROCESSING');
  assert.equal((await query("SELECT state FROM jobs WHERE kind='REFUND'"))[0].state, 'DONE', 'the job is done once the provider holds the refund');
  // Provider finishes; the poller picks it up.
  fake.refunds.get(r.provider_refund_id)!.status = 'processed';
  await query("UPDATE refunds SET last_checked_at=now() - interval '1 hour' WHERE id=$1", [r.id]);
  await refunds.pollProcessingRefunds();
  assert.equal((await query('SELECT state FROM refunds WHERE id=$1', [r.id]))[0].state, 'SUCCEEDED');
});

test('failed refund opens a case and alert; a late "processed" webhook cannot flip a terminal state', { skip }, async () => {
  const show = await makeShow();
  const b = await buy(await makeUser(), show.productId);
  await cancel(await makeUser('owner'), show.showId);
  fake.refundStatus = 'failed';
  await jobs.processJobs();
  const r = (await query<{ id: string; state: string; provider_refund_id: string }>('SELECT id, state, provider_refund_id FROM refunds WHERE booking_id=$1', [b.bookingId]))[0];
  assert.equal(r.state, 'FAILED');
  assert.equal((await query("SELECT count(*)::int n FROM reconciliation_cases WHERE key=$1", ['refund-failed:' + r.id]))[0].n, 1);
  const { opsStatus } = await import('../src/lib/ops');
  assert.ok((await opsStatus()).critical.some((c) => /refund/.test(c)));
  const { body, signature } = webhook('refund.processed', { id: r.provider_refund_id, status: 'processed', notes: { refundId: r.id } }, 'refund');
  await payments.ingestRazorpayWebhook(body, signature);
  assert.equal((await query('SELECT state FROM refunds WHERE id=$1', [r.id]))[0].state, 'FAILED');
});

test('refund.processed webhook completes a PROCESSING refund', { skip }, async () => {
  const show = await makeShow();
  const b = await buy(await makeUser(), show.productId);
  await cancel(await makeUser('owner'), show.showId);
  fake.refundStatus = 'pending';
  await jobs.processJobs();
  const r = (await query<{ id: string; provider_refund_id: string }>('SELECT id, provider_refund_id FROM refunds WHERE booking_id=$1', [b.bookingId]))[0];
  const { body, signature } = webhook('refund.processed', { id: r.provider_refund_id, status: 'processed', notes: { refundId: r.id } }, 'refund');
  await payments.ingestRazorpayWebhook(body, signature);
  assert.equal((await query('SELECT state FROM refunds WHERE id=$1', [r.id]))[0].state, 'SUCCEEDED');
});
