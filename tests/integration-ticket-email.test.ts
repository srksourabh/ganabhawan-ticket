/**
 * Ticket confirmation email: after a verified payment the customer gets an HTML email (plus the
 * plain-text alternative) listing every ticket with its own ticket number and QR code; the
 * organisation gets its own copy (TICKET_COPY_EMAIL); retries duplicate neither emails nor tickets;
 * an email failure never touches the paid booking; QR image links are signed and stop working when
 * a ticket is cancelled. Real checkout, payment, job and ticket code on the local test database;
 * Razorpay and Resend are the in-process fakes (no real email is sent).
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const ORG = 'org-copy@tickets.test';
let auth: typeof import('../src/lib/auth');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let attempts: typeof import('../src/lib/attempts');
let jobs: typeof import('../src/lib/jobs');
let email: typeof import('../src/lib/ticket-email');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  process.env.TICKET_COPY_EMAIL = ORG;
  fake.install();
  auth = await import('../src/lib/auth');
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  attempts = await import('../src/lib/attempts');
  jobs = await import('../src/lib/jobs');
  email = await import('../src/lib/ticket-email');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  process.env.TICKET_COPY_EMAIL = 'off';
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
async function guestBuys(name: string, mail: string, phone: string, show: { productId: string }, quantity = 2) {
  const g = await guest(name, mail, phone);
  const attempt = await attempts.recordBookingAttempt({ name, email: mail, phone, contact: mail, productId: show.productId, quantity, userId: g.user.id });
  const co = await checkout.createCheckout(g.user, [line(show, quantity)], randomUUID());
  await attempts.linkAttempt(String((attempt as { id: string }).id), g.user.id, g.user.contact, co.bookings[0].id, 'HELD');
  await payCheckout(g.user, co.id);
  return { g, co };
}

test('guest buys 2 tickets: unique ticket numbers, HTML + text email with a QR per ticket, organisation copy, no duplicates on retry', { skip }, async () => {
  const show = await makeShow({ title: 'Raktakarabi' });
  const { co } = await guestBuys('Mita <Ray>', 'mita@tickets.test', '+919876500005', show, 2);
  assert.equal((await checkout.checkoutReceipt((await query<{ user_id: string }>('SELECT user_id FROM checkouts WHERE id=$1', [co.id]))[0].user_id, co.id)).status, 'CONFIRMED');
  await jobs.processJobs();
  const tickets = await query<{ id: string; reference: string }>("SELECT t.id, t.reference FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 ORDER BY t.ordinal", [co.id]);
  assert.equal(tickets.length, 2);
  assert.equal(new Set(tickets.map((t) => t.reference)).size, 2, 'unique within the booking');
  const customer = fake.emails.filter((e) => e.to === 'mita@tickets.test');
  const copy = fake.emails.filter((e) => e.to === ORG);
  assert.equal(customer.length, 1, 'one customer email');
  assert.equal(copy.length, 1, 'one organisation copy');
  assert.match(copy[0].subject, /^\[Copy\] /);
  const mail = customer[0];
  assert.ok(mail.html, 'HTML version sent');
  for (const t of tickets) {
    assert.ok(mail.text.includes(t.reference), `text has ${t.reference}`);
    assert.ok(mail.html!.includes(t.reference), `html has ${t.reference}`);
    assert.ok(mail.html!.includes(email.ticketQrUrl(process.env.APP_URL!, t.id)), 'a QR image per ticket');
    assert.ok(mail.text.includes(email.ticketQrUrl(process.env.APP_URL!, t.id)), 'text alternative links each QR');
  }
  assert.equal((mail.html!.match(/<img [^>]*alt="QR code for ticket/g) ?? []).length, 2);
  assert.ok(!/<script/i.test(mail.html!) && !/<link /i.test(mail.html!), 'no script, no external CSS');
  assert.ok(mail.html!.includes('Mita &lt;Ray&gt;') && !mail.html!.includes('Mita <Ray>'), 'customer data escaped');
  assert.match(mail.html!, /name="viewport"/);
  assert.match(mail.html!, /Raktakarabi/);
  assert.match(mail.html!, /Payment status/);
  assert.ok(!mail.html!.includes(ORG) && !mail.text.includes(ORG), 'the organisation address is not shown to the customer');
  // Retry the delivery (job re-run and a re-queued job): no new email, no new tickets, same numbers.
  await query("UPDATE jobs SET state='PENDING', run_at=now() WHERE kind='DELIVERY'");
  await jobs.processJobs();
  assert.equal(fake.emails.filter((e) => e.to === 'mita@tickets.test').length, 1);
  assert.equal(fake.emails.filter((e) => e.to === ORG).length, 1);
  const after = await query<{ reference: string }>("SELECT t.reference FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 ORDER BY t.ordinal", [co.id]);
  assert.deepEqual(after.map((t) => t.reference), tickets.map((t) => t.reference), 'ticket numbers stable');
});

test('ticket numbers are unique across bookings (database constraint) and never reused', { skip }, async () => {
  const show = await makeShow({ allocation: 10 });
  await guestBuys('A', 'a1@tickets.test', '+919876500006', show, 3);
  await guestBuys('B', 'b1@tickets.test', '+919876500007', show, 3);
  const refs = (await query<{ reference: string }>('SELECT reference FROM tickets')).map((r) => r.reference);
  assert.equal(refs.length, 6);
  assert.equal(new Set(refs).size, 6);
  const one = (await query<{ booking_id: string }>('SELECT booking_id FROM tickets LIMIT 1'))[0];
  await assert.rejects(query("INSERT INTO tickets(booking_id,ordinal,reference) VALUES($1,99,$2)", [one.booking_id, refs[0]]), /duplicate|unique/i);
});

test('email failure does not lose the paid booking; the retry sends it once', { skip }, async () => {
  const show = await makeShow();
  fake.failEmail = true;
  const { co } = await guestBuys('C', 'c1@tickets.test', '+919876500008', show, 1);
  await jobs.processJobs();
  assert.equal(await count("SELECT count(*)::int n FROM bookings WHERE checkout_id=$1 AND status='CONFIRMED'", [co.id]), 1, 'still confirmed');
  assert.equal(await count("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1", [co.id]), 1);
  fake.failEmail = false;
  await query("UPDATE jobs SET run_at=now() WHERE kind='DELIVERY' AND state<>'DONE'");
  await jobs.processJobs();
  assert.equal(fake.emails.filter((e) => e.to === 'c1@tickets.test').length, 1);
  assert.equal(await count("SELECT count(*)::int n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1", [co.id]), 1, 'no new tickets');
});

// ---- QR IMAGES ---------------------------------------------------------------------------------------

test('ticket QR image: signed link serves the existing credential; forged, unknown or cancelled tickets get 404', { skip }, async () => {
  const show = await makeShow();
  const { co } = await guestBuys('D', 'd1@tickets.test', '+919876500009', show, 1);
  const ticket = (await query<{ id: string }>('SELECT t.id FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1', [co.id]))[0];
  const { GET } = await import('../app/api/ticket-qr/[code]/route');
  const get = (code: string) => GET(new Request('https://staging.tickets.test/api/ticket-qr/' + code), { params: Promise.resolve({ code }) });
  const ok = await get(email.ticketQrCode(ticket.id));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  const png = new Uint8Array(await ok.arrayBuffer());
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
  const [id, sig] = email.ticketQrCode(ticket.id).split('.');
  assert.equal((await get(`${id}.${sig.slice(0, -1)}x`)).status, 404, 'forged signature');
  assert.equal((await get(`${randomUUID()}.${sig}`)).status, 404, 'another ticket id with this signature');
  assert.equal((await get(id)).status, 404, 'no signature');
  assert.equal(email.ticketIdFromQrCode(email.ticketQrCode(ticket.id)), ticket.id);
  await query("UPDATE tickets SET status='CANCELLED' WHERE id=$1", [ticket.id]);
  assert.equal((await get(email.ticketQrCode(ticket.id))).status, 404, 'cancelled ticket');
});
