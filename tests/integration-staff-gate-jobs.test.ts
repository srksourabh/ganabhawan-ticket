/**
 * DB-backed staff login (email + password, two doors), session revocation, gate
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

/** A staff account that can sign in (email + password; there is no second factor). */
async function staffAccount(role: User['role']) {
  const contact = `${role}-${randomUUID().slice(0, 6)}@tickets.test`;
  await staff.upsertStaff({ contact, role, password: PASSWORD });
  return contact;
}

const sessions = async (contact: string) =>
  (await query<{ n: number }>('SELECT count(*)::int n FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.contact=$1', [contact]))[0].n;

test('staff login is email + password only: no authenticator, wrong password refused, password stored only as a hash', { skip }, async () => {
  const contact = await staffAccount('scanner');
  await assert.rejects(() => auth.loginStaff(contact, 'wrong password here', 'gate', '10.0.0.1'), /Incorrect/);
  const session = await auth.loginStaff(contact, PASSWORD, 'gate', '10.0.0.1');
  assert.equal(session.user.role, 'scanner');
  assert.ok(await auth.sessionUser(session.sessionToken!), 'a normal hashed-token session');
  const row = (await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE contact=$1', [contact]))[0];
  assert.ok(row.password_hash.startsWith('scrypt$') || !row.password_hash.includes(PASSWORD), 'only a hash is stored');
  assert.ok((await query("SELECT count(*)::int n FROM audit_events WHERE action='auth.password.failed'"))[0].n >= 1);
});

test('two doors: admin roles only at /admin/login, gate roles only at /gate/login; the wrong door creates no session', { skip }, async () => {
  const expect = { owner: 'admin', inventory: 'admin', finance: 'admin', desk: 'admin', scanner: 'gate', supervisor: 'gate' } as const;
  for (const [role, door] of Object.entries(expect) as [User['role'], 'admin' | 'gate'][]) {
    const contact = await staffAccount(role);
    const wrong = door === 'admin' ? 'gate' : 'admin';
    const refused = await auth.loginStaff(contact, PASSWORD, wrong, '10.0.1.1').catch((e) => e);
    assert.equal(refused.code, 'WRONG_PORTAL', `${role} at ${wrong}`);
    assert.equal(refused.status, 403);
    assert.equal(await sessions(contact), 0, `${role}: no session from the wrong door`);
    const ok = await auth.loginStaff(contact, PASSWORD, door, '10.0.1.1');
    assert.equal(ok.user.role, role, `${role} at ${door}`);
  }
  const scanner = await staffAccount('scanner');
  await assert.rejects(() => auth.loginStaff(scanner, PASSWORD, 'somewhere' as never, '10.0.1.1'), /admin or gate/);
});

test('customers never get staff access: no password login, no staff session, refused at both doors', { skip }, async () => {
  const customer = await makeUser();
  for (const door of ['admin', 'gate'] as const) {
    await assert.rejects(() => auth.loginStaff(customer.contact, PASSWORD, door, '10.0.2.1'), /Incorrect email or password/);
  }
  // Even with a password hash, a customer account is refused.
  const { hashPassword } = await import('../src/lib/security');
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(PASSWORD), customer.id]);
  await assert.rejects(() => auth.loginStaff(customer.contact, PASSWORD, 'admin', '10.0.2.1'), /not a staff account/);
  assert.equal(await sessions(customer.contact), 0);
});

test('staff cannot sign in with a customer code (OTP) or with Clerk/Google; customers still can use their code', { skip }, async () => {
  const contact = await staffAccount('owner');
  const { keyedHash } = await import('../src/lib/security');
  const challenge = (await query<{ id: string }>(
    "INSERT INTO otp_challenges(contact,digest,expires_at) VALUES($1,$2,now()+interval '5 minutes') RETURNING id", [contact, keyedHash(contact + ':123456')]))[0];
  await assert.rejects(() => auth.verifyOtp(challenge.id, '123456'), /Staff accounts sign in with email and password/);
  assert.equal(await sessions(contact), 0, 'a customer code is never a password-less staff login');
  await assert.rejects(() => auth.ensureUserFromClerk('clerk_123', contact), /must sign in with email and password/);
  const customer = await makeUser();
  const own = (await query<{ id: string }>(
    "INSERT INTO otp_challenges(contact,digest,expires_at) VALUES($1,$2,now()+interval '5 minutes') RETURNING id", [customer.contact, keyedHash(customer.contact + ':654321')]))[0];
  assert.equal((await auth.verifyOtp(own.id, '654321')).user.role, 'customer', 'customer sign-in by code is unchanged');
});

test('password reset requires 12+ characters, signs the account out everywhere; deactivation removes access', { skip }, async () => {
  const contact = await staffAccount('supervisor');
  const s1 = await auth.loginStaff(contact, PASSWORD, 'gate', '10.0.0.3');
  await assert.rejects(() => staff.setStaffPassword(contact, 'short'), /12 characters/);
  await staff.setStaffPassword(contact, 'a brand new long password');
  assert.equal(await auth.sessionUser(s1.sessionToken!), null);
  await assert.rejects(() => auth.loginStaff(contact, PASSWORD, 'gate', '10.0.0.3'), /Incorrect/);
  await auth.loginStaff(contact, 'a brand new long password', 'gate', '10.0.0.3');
  await staff.revokeStaff(contact, 'season over');
  await assert.rejects(() => auth.loginStaff(contact, 'a brand new long password', 'gate', '10.0.0.3'), /Incorrect/);
  assert.equal(await sessions(contact), 0);
});

test('logout revokes the session server-side; other devices and expiry behave correctly', { skip }, async () => {
  const contact = await staffAccount('finance');
  const laptop = await auth.loginStaff(contact, PASSWORD, 'admin', '10.0.0.4');
  const phone = await auth.loginStaff(contact, PASSWORD, 'admin', '10.0.0.4');
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
  const contact = await staffAccount('scanner');
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
  const contact = await staffAccount('scanner');
  const scanner = (await query<User>('SELECT id,contact,name,role FROM users WHERE contact=$1', [contact]))[0];
  const ticket = await confirmedTicket(later.productId);
  assert.match((await scan(scanner, later.showId, ticket.token)).reason ?? '', /time window/);
});

test('shows created after a scanner was provisioned get that scanner scoped automatically', { skip }, async () => {
  await makeShow();
  const contact = await staffAccount('scanner');
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
  const ops = await opsStatus();
  assert.ok(ops.warnings.some((c) => /permanently failed/.test(c)), 'surfaced to operations');
  assert.equal(ops.critical.length, 0, 'an undelivered email is not a money emergency');
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

test('mobile scanner app contract: gate sign-in with x-client mobile returns a bearer token that scans; office accounts and customer codes are refused', { skip }, async () => {
  const { POST } = await import('../app/api/auth/password/route');
  const signIn = (email: string, portal: string) => POST(new Request('https://staging.tickets.test/api/auth/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-client': 'mobile' }, body: JSON.stringify({ email, password: PASSWORD, portal }),
  }));
  // The show exists first: a scanner is scoped to upcoming shows when the account is created.
  const show = await makeShow({ startsInMinutes: 30 });
  const t = await confirmedTicket(show.productId);
  const scannerContact = await staffAccount('scanner');
  const res = await signIn(scannerContact, 'gate');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sessionToken?: string; user?: { role: string } };
  assert.equal(body.user?.role, 'scanner');
  assert.ok(body.sessionToken, 'the app receives a bearer token');
  // The token is what the app sends as "Authorization: Bearer …"; it identifies the scanner…
  const scanner = await auth.sessionUser(body.sessionToken!);
  assert.equal(scanner?.role, 'scanner');
  // …who admits a valid ticket through the unchanged gate checks (scopes on gate-one, as the app sends).
  assert.equal((await scan(scanner!, show.showId, t.token)).result, 'ADMITTED');
  assert.equal((await scan(scanner!, show.showId, t.token)).reason, 'Ticket already admitted for this show.');
  // Office staff cannot use the gate door from the app; no portal at all is refused.
  const office = await signIn(await staffAccount('finance'), 'gate');
  assert.equal(office.status, 403);
  assert.equal((await signIn(scannerContact, '')).status, 400);
  // The customer-code path refuses staff (no password-less staff session).
  const { keyedHash } = await import('../src/lib/security');
  const challenge = (await query<{ id: string }>(
    "INSERT INTO otp_challenges(contact,digest,expires_at) VALUES($1,$2,now()+interval '5 minutes') RETURNING id", [scannerContact, keyedHash(scannerContact + ':111222')]))[0];
  await assert.rejects(() => auth.verifyOtp(challenge.id, '111222'), /Staff accounts sign in with email and password/);
});
