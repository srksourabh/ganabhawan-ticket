/**
 * DB-backed staff MFA provisioning and login, session revocation, gate
 * authorisation, background-job recovery and notification delivery.
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
let staff: typeof import('../src/lib/staff');
let security: typeof import('../src/lib/security');
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let admission: typeof import('../src/lib/admission');
let catalogue: typeof import('../src/lib/catalogue');
let jobs: typeof import('../src/lib/jobs');
let tickets: typeof import('../src/lib/tickets');
let query: typeof import('../src/lib/db').query;
const PASSWORD = 'correct horse battery staple';

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  auth = await import('../src/lib/auth');
  staff = await import('../src/lib/staff');
  security = await import('../src/lib/security');
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  admission = await import('../src/lib/admission');
  catalogue = await import('../src/lib/catalogue');
  jobs = await import('../src/lib/jobs');
  tickets = await import('../src/lib/tickets');
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

async function currentCode(contact: string, offsetSteps = 0) {
  const row = (await query<{ mfa_secret: string }>('SELECT mfa_secret FROM users WHERE contact=$1', [contact]))[0];
  return security.totpCode(security.decrypt(row.mfa_secret), security.totpStepAt() + offsetSteps);
}

async function enrolledStaff(role: User['role']) {
  const contact = `${role}-${randomUUID().slice(0, 6)}@tickets.test`;
  await staff.upsertStaff({ contact, role, password: PASSWORD });
  const { secret } = await staff.beginMfaEnrollment(contact);
  await staff.confirmMfaEnrollment(contact, security.totpCode(secret, security.totpStepAt() - 1));
  return contact;
}

test('MFA enrolment: secret encrypted at rest, pending until a valid code, wrong code rejected', { skip }, async () => {
  const contact = 'scanner-enrol@tickets.test';
  await staff.upsertStaff({ contact, role: 'scanner', password: PASSWORD });
  const { secret, uri } = await staff.beginMfaEnrollment(contact);
  assert.ok(uri.startsWith('otpauth://totp/'));
  const row = (await query('SELECT mfa_secret, mfa_pending_secret FROM users WHERE contact=$1', [contact]))[0];
  assert.equal(row.mfa_secret, null, 'not active until confirmed');
  assert.ok(!String(row.mfa_pending_secret).includes(secret), 'stored encrypted, never plain');
  assert.equal(security.decrypt(row.mfa_pending_secret), secret);
  await assert.rejects(() => staff.confirmMfaEnrollment(contact, '000000'), /not valid/);
  await staff.confirmMfaEnrollment(contact, security.totpCode(secret, security.totpStepAt()));
  const enabled = (await query('SELECT mfa_secret IS NOT NULL AS on, mfa_pending_secret FROM users WHERE contact=$1', [contact]))[0];
  assert.deepEqual(enabled, { on: true, mfa_pending_secret: null });
  await assert.rejects(() => staff.beginMfaEnrollment(contact), /already enabled/);
  const customer = await makeUser();
  await assert.rejects(() => staff.beginMfaEnrollment(customer.contact), /Only staff/);
});

test('live staff login: password alone fails, password+TOTP works, the same code cannot be replayed', { skip }, async () => {
  const contact = await enrolledStaff('scanner');
  await assert.rejects(() => auth.loginWithPassword(contact, PASSWORD, '', '10.0.0.1'), /authenticator code/);
  const anyCode = await currentCode(contact);
  await assert.rejects(() => auth.loginWithPassword(contact, 'wrong password here', anyCode, '10.0.0.1'), /Incorrect/);
  const code = await currentCode(contact, 1);
  const session = await auth.loginWithPassword(contact, PASSWORD, code, '10.0.0.1');
  assert.equal(session.user.role, 'scanner');
  await assert.rejects(() => auth.loginWithPassword(contact, PASSWORD, code, '10.0.0.1'), /authenticator code/, 'replayed code refused');
  assert.ok((await query("SELECT count(*)::int n FROM audit_events WHERE action='auth.mfa.failed'"))[0].n >= 2);
});

test('staff without enrolled MFA cannot sign in in live mode; Clerk/Google is refused for staff', { skip }, async () => {
  const contact = 'owner-nomfa@tickets.test';
  await staff.upsertStaff({ contact, role: 'owner', password: PASSWORD });
  await assert.rejects(() => auth.loginWithPassword(contact, PASSWORD, '123456', '10.0.0.2'), /authenticator code/);
  await assert.rejects(() => auth.ensureUserFromClerk('clerk_123', contact), /must sign in with a password/);
});

test('MFA reset requires a reason, clears MFA and revokes every session', { skip }, async () => {
  const contact = await enrolledStaff('supervisor');
  const s1 = await auth.loginWithPassword(contact, PASSWORD, await currentCode(contact, 1), '10.0.0.3');
  await assert.rejects(() => staff.resetMfa(contact, ''), /reason/);
  await staff.resetMfa(contact, 'lost phone');
  assert.equal(await auth.sessionUser(s1.sessionToken!), null);
  await assert.rejects(() => auth.loginWithPassword(contact, PASSWORD, '123456', '10.0.0.3'), /authenticator code/);
});

test('logout revokes the session server-side; other devices and expiry behave correctly', { skip }, async () => {
  const contact = await enrolledStaff('finance');
  const laptop = await auth.loginWithPassword(contact, PASSWORD, await currentCode(contact, 1), '10.0.0.4');
  // A second device signs in on a later code (codes are single-use).
  await query('UPDATE users SET mfa_last_step=mfa_last_step-2 WHERE contact=$1', [contact]);
  const phone = await auth.loginWithPassword(contact, PASSWORD, await currentCode(contact, 0), '10.0.0.4');
  assert.ok(await auth.sessionUser(laptop.sessionToken!));
  await auth.revokeSession(laptop.sessionToken!);
  assert.equal(await auth.sessionUser(laptop.sessionToken!), null, 'old cookie/bearer is dead');
  assert.ok(await auth.sessionUser(phone.sessionToken!), 'logging out one device leaves the other');
  await query("UPDATE sessions SET expires_at=now() - interval '1 second'");
  assert.equal(await auth.sessionUser(phone.sessionToken!), null, 'expired sessions are rejected');
});

async function confirmedTicket(showProductId: string) {
  const user = await makeUser();
  const h = (await commerce.reserve(user, { productId: showProductId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  const order = await payments.createPaymentOrder(user, h.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  const row = (await query<{ encrypted_token: string }>('SELECT c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id WHERE t.booking_id=$1', [h.id]))[0];
  return { user, bookingId: h.id, token: security.decrypt(row.encrypted_token) };
}

const scan = (who: User, showId: string, token: string, device = 'gate-one') =>
  admission.admit(who, { requestId: randomUUID(), ticketToken: token, showId, gateId: device, deviceId: device });

test('gate: scoped scanner admits; re-entry, wrong show, unknown code, revoked device and unscoped staff are refused', { skip }, async () => {
  const tonight = await makeShow({ startsInMinutes: 30 });
  const other = await makeShow({ startsInMinutes: 40 });
  const contact = await enrolledStaff('scanner');
  const scanner = (await query<User>('SELECT id,contact,name,role FROM users WHERE contact=$1', [contact]))[0];
  const ticket = await confirmedTicket(tonight.productId);

  assert.equal((await scan(scanner, tonight.showId, ticket.token)).result, 'ADMITTED');
  assert.match((await scan(scanner, tonight.showId, ticket.token)).reason ?? '', /already admitted/);
  assert.match((await scan(scanner, other.showId, ticket.token)).reason ?? '', /No active entitlement/);
  assert.equal((await scan(scanner, tonight.showId, 'not-a-real-token')).result, 'UNKNOWN');

  const second = await confirmedTicket(tonight.productId);
  await query("UPDATE devices SET revoked=true WHERE id='gate-two'");
  assert.match((await scan(scanner, tonight.showId, second.token, 'gate-two')).reason ?? '', /revoked|not authorized/i);

  const outsider = await makeUser('scanner');
  assert.match((await scan(outsider, tonight.showId, second.token)).reason ?? '', /not authorized/);
  const owner = await makeUser('owner');
  assert.equal((await scan(owner, tonight.showId, second.token)).result, 'ADMITTED', 'owner bypasses scopes');
  const customer = await makeUser('customer');
  await assert.rejects(() => scan(customer, tonight.showId, second.token), /permission/);
});

test('gate: entry outside the window is refused (too early)', { skip }, async () => {
  const later = await makeShow({ startsInMinutes: 6 * 60 });
  const contact = await enrolledStaff('scanner');
  const scanner = (await query<User>('SELECT id,contact,name,role FROM users WHERE contact=$1', [contact]))[0];
  const ticket = await confirmedTicket(later.productId);
  assert.match((await scan(scanner, later.showId, ticket.token)).reason ?? '', /time window/);
});

test('shows created after a scanner was provisioned get that scanner scoped automatically', { skip }, async () => {
  await makeShow();
  const contact = await enrolledStaff('scanner');
  const owner = await makeUser('owner');
  const created = await catalogue.upsertShow(owner, {
    title: 'New play', titleBn: 'নতুন', troupe: 'T', synopsis: 'S', synopsisBn: 'S',
    startsAt: new Date(Date.now() + 86_400_000).toISOString(), runtime: 90, genre: 'Drama', status: 'PUBLISHED',
  });
  const scopes = await query("SELECT 1 FROM staff_scopes s JOIN users u ON u.id=s.user_id WHERE u.contact=$1 AND s.show_id=$2", [contact, created.id]);
  assert.equal(scopes.length, 2, 'both gates');
});

test('worker crash: a stale RUNNING job is reclaimed and completed', { skip }, async () => {
  const show = await makeShow();
  const t = await confirmedTicket(show.productId);
  await query("UPDATE jobs SET state='RUNNING', locked_at=now() - interval '20 minutes' WHERE kind='DELIVERY'");
  const summary = await jobs.processJobs();
  assert.equal(summary.reclaimed, 1);
  assert.equal((await query("SELECT state FROM jobs WHERE key=$1", ['confirmation:' + t.bookingId]))[0].state, 'DONE');
});

test('email: correct ticket link; provider failure retries (never DONE), then FAILED and surfaced', { skip }, async () => {
  const show = await makeShow();
  fake.failEmail = true;
  const t = await confirmedTicket(show.productId);
  await jobs.processJobs();
  let job = (await query("SELECT state, attempts, last_error FROM jobs WHERE key=$1", ['confirmation:' + t.bookingId]))[0];
  assert.equal(job.state, 'PENDING');
  assert.equal(job.attempts, 1);
  for (let i = 0; i < 6; i += 1) {
    await query("UPDATE jobs SET run_at=now() WHERE key=$1 AND state='PENDING'", ['confirmation:' + t.bookingId]);
    await jobs.processJobs();
  }
  job = (await query("SELECT state, attempts FROM jobs WHERE key=$1", ['confirmation:' + t.bookingId]))[0];
  assert.deepEqual(job, { state: 'FAILED', attempts: 5 }, 'bounded retries, then FAILED');
  const { opsStatus } = await import('../src/lib/ops');
  assert.ok((await opsStatus()).critical.some((c) => /permanently failed/.test(c)));
  // The ticket is still available in the app without email.
  assert.equal((await commerce.ownedBookings(t.user.id, t.bookingId))[0].status, 'CONFIRMED');
  fake.failEmail = false;
  await tickets.deliverBooking(t.bookingId);
  const sent = fake.emails.at(-1)!;
  assert.equal(sent.to, t.user.contact);
  assert.ok(sent.text.includes(`https://staging.tickets.test/tickets/${t.bookingId}`));
});

test('customers cannot read another customer\'s booking or ticket', { skip }, async () => {
  const show = await makeShow();
  const mine = await confirmedTicket(show.productId);
  const intruder = await makeUser();
  assert.deepEqual(await commerce.ownedBookings(intruder.id, mine.bookingId), []);
  const ticketId = (await query<{ id: string }>('SELECT id FROM tickets WHERE booking_id=$1', [mine.bookingId]))[0].id;
  await assert.rejects(() => tickets.ticketPass(intruder, ticketId));
});

test('holder name entered at checkout is attached to the booking for its owner only', { skip }, async () => {
  const show = await makeShow();
  const user = await makeUser();
  const { recordBookingAttempt, linkAttempt } = await import('../src/lib/attempts');
  const attempt = await recordBookingAttempt({ name: 'Anita Roy', contact: user.contact, productId: show.productId, quantity: 1, userId: user.id });
  const h = (await commerce.reserve(user, { productId: show.productId, quantity: 1, version: 1 }, randomUUID())) as { id: string };
  await linkAttempt(attempt.id, user.id, user.contact, h.id, 'HELD');
  assert.equal((await commerce.ownedBookings(user.id, h.id))[0].holder_name, 'Anita Roy');
  assert.deepEqual(await commerce.ownedBookings((await makeUser()).id, h.id), []);
});
