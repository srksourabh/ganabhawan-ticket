/**
 * MSG91 as the single SMS provider (sign-in codes + confirmations), email-only /
 * mobile-only / both customers, and the secure QR-ticket link in every channel.
 * Real auth, checkout, payment, job and admission code on the local test database;
 * only Razorpay, Resend and MSG91 are the in-process fakes (tests/helpers/fake-razorpay.ts).
 * Nothing is sent to a real phone or mailbox.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv, webhook } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const CARDS = 'Please collect your physical cards before the show.';
let auth: typeof import('../src/lib/auth');
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let jobs: typeof import('../src/lib/jobs');
let admission: typeof import('../src/lib/admission');
let env: typeof import('../src/lib/env');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  auth = await import('../src/lib/auth');
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  jobs = await import('../src/lib/jobs');
  admission = await import('../src/lib/admission');
  env = await import('../src/lib/env');
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

const otpSms = () => fake.sms.filter((s) => s.templateId === 'tmpl-otp');
const confirmSms = (mobile: string) => fake.sms.filter((s) => s.templateId === 'tmpl-confirm' && '+' + s.to === mobile);
const emailsTo = (to: string) => fake.emails.filter((e) => e.to === to);
const emailCode = (to: string) => /code is (\d{6})/.exec(emailsTo(to).at(-1)!.text)![1];
const smsCode = () => otpSms().at(-1)!.variables.OTP;
const userCount = async () => (await query('SELECT count(*)::int n FROM users'))[0].n as number;

function captureErrors() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  return run().finally(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}

/** Pay a cart of `lines` products through the real checkout + signed callback. */
async function buy(user: User, quantities: number[]) {
  const shows = [];
  while (shows.length < quantities.length) shows.push(await makeShow({ price: 30000 }));
  const co = await checkout.createCheckout(user, shows.map((s, i) => ({ productId: s.productId, quantity: quantities[i], version: 1 })), randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return { co, shows, payment: p };
}

/** Two ticks: DELIVERY (email + queues the SMS job), then NOTIFY (SMS). */
async function deliver() {
  await jobs.processJobs();
  await query("UPDATE jobs SET run_at=now() WHERE state='PENDING'");
  await jobs.processJobs();
}

const bookingsOf = async (checkoutId: string) =>
  (await query<{ id: string }>('SELECT id FROM bookings WHERE checkout_id=$1 ORDER BY created_at, id', [checkoutId])).map((r) => r.id);

// ---- AUTHENTICATION ---------------------------------------------------------------------------------

test('auth 1/9: email-only customer signs in with the email code; an existing email account is reused', { skip }, async () => {
  const existing = await makeUser('customer', 'reader@tickets.test', { mobile: null });
  const before = await userCount();
  const req = await auth.requestOtp('Reader@Tickets.test', '10.2.0.1');
  assert.equal('developmentCode' in req, false, 'live mode never returns the code');
  assert.equal(otpSms().length, 0, 'an email code never goes to MSG91');
  const session = await auth.verifyOtp(req.challengeId, emailCode('reader@tickets.test'));
  assert.equal(session.user.id, existing.id);
  assert.equal(await userCount(), before, 'no new account');
});

test('auth 2/10: mobile-only customer signs in with an MSG91 OTP (OTP template, code hashed, existing account reused)', { skip }, async () => {
  const existing = await makeUser('customer', '+919876500001');
  const req = await auth.requestOtp('98765 00001', '10.2.0.2');
  assert.equal(otpSms().length, 1);
  const sent = otpSms()[0];
  assert.equal(sent.to, '919876500001', 'MSG91 number format (no +)');
  assert.match(sent.variables.OTP, /^\d{6}$/);
  assert.equal(confirmSms('+919876500001').length, 0);
  const row = (await query<{ digest: string }>('SELECT digest FROM otp_challenges WHERE id=$1', [req.challengeId]))[0];
  assert.ok(!row.digest.includes(sent.variables.OTP), 'stored as a keyed hash, never the code');
  const session = await auth.verifyOtp(req.challengeId, smsCode());
  assert.equal(session.user.id, existing.id);
});

test('auth 3: email account with a verified mobile → signing in with that mobile opens the SAME account (no duplicate)', { skip }, async () => {
  const both = await makeUser('customer', 'both@tickets.test', { mobile: '+919876500003' });
  const before = await userCount();
  const req = await auth.requestOtp('+919876500003', '10.2.0.3');
  const session = await auth.verifyOtp(req.challengeId, smsCode());
  assert.equal(session.user.id, both.id);
  assert.equal(await userCount(), before);
  const email = await auth.requestOtp('both@tickets.test', '10.2.0.3');
  assert.equal((await auth.verifyOtp(email.challengeId, emailCode('both@tickets.test'))).user.id, both.id);
});

test('auth 4/5/6: wrong, expired and reused codes are rejected and create no session', { skip }, async () => {
  const sessions = async () => (await query('SELECT count(*)::int n FROM sessions'))[0].n as number;
  const req = await auth.requestOtp('+919876500004', '10.2.0.4');
  const code = smsCode();
  await assert.rejects(auth.verifyOtp(req.challengeId, code === '000000' ? '111111' : '000000'), /incorrect/i);
  assert.equal(await sessions(), 0);
  await auth.verifyOtp(req.challengeId, code);
  await assert.rejects(auth.verifyOtp(req.challengeId, code), /expired|no longer valid/, 'a code works once');
  assert.equal(await sessions(), 1);

  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  const late = await auth.requestOtp('+919876500004', '10.2.0.4');
  await query("UPDATE otp_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [late.challengeId]);
  await assert.rejects(auth.verifyOtp(late.challengeId, smsCode()), /expired|no longer valid/);
  assert.equal(await sessions(), 1);
});

test('auth 7: OTP requests are rate-limited (30 s apart, 5 per contact per hour)', { skip }, async () => {
  await auth.requestOtp('+919876500005', '10.2.0.5');
  await assert.rejects(auth.requestOtp('+919876500005', '10.2.0.5'), /30 seconds/);
  // Every request counts toward the hourly limit, the refused one included: 2 used, 3 more allowed.
  for (let i = 0; i < 3; i++) {
    await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
    await auth.requestOtp('+919876500005', '10.2.0.5');
  }
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  await assert.rejects(auth.requestOtp('+919876500005', '10.2.0.5'), /Too many attempts/);
  assert.equal(otpSms().length, 4, 'no SMS for refused requests');
});

test('auth 8: an MSG91 failure is reported (never "code sent"); logs carry no number, code or key', { skip }, async () => {
  const underlying = globalThis.fetch;
  let code = '';
  // MSG91 echoes the recipient and the code back in its error.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    code = body.recipients[0].OTP;
    return new Response(JSON.stringify({ type: 'error', message: `cannot deliver to ${body.recipients[0].mobiles}: ${code}` }), { status: 400 });
  }) as typeof fetch;
  const log = captureErrors();
  try {
    await assert.rejects(auth.requestOtp('+919876500006', '10.2.0.6'), /SMS delivery is temporarily unavailable/);
  } finally {
    log.restore();
    globalThis.fetch = underlying;
  }
  const line = log.lines.find((l) => l.startsWith('msg91 otp send failed'))!;
  assert.ok(line, 'failure logged for diagnosis');
  for (const secret of ['9876500006', code, 'test-auth-key']) assert.ok(!line.includes(secret), `log never contains ${secret}`);
  assert.equal((await query('SELECT count(*)::int n FROM sessions'))[0].n, 0);
});

test('auth: a 200 response without MSG91 "success" is a failure, not a delivered code', { skip }, async () => {
  const underlying = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  const log = captureErrors();
  try {
    await assert.rejects(auth.requestOtp('+919876500007', '10.2.0.7'), /temporarily unavailable/);
  } finally {
    log.restore();
    globalThis.fetch = underlying;
  }
});

test('auth: httpSMS is never used in live mode, even when its keys are present (no fallback)', { skip }, async () => {
  const underlying = globalThis.fetch;
  let httpsmsCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('httpsms.com')) httpsmsCalls++;
    return underlying(input, init);
  }) as typeof fetch;
  try {
    await withEnv({ HTTPSMS_API_KEY: 'stub', HTTPSMS_FROM: '+919111222333' }, async () => {
      await auth.requestOtp('+919876500008', '10.2.0.8');
      fake.failSms = true;
      await assert.rejects(auth.requestOtp('+919876500009', '10.2.0.8'), /temporarily unavailable/);
    });
  } finally {
    globalThis.fetch = underlying;
  }
  assert.equal(httpsmsCalls, 0);
  assert.equal(otpSms().length, 1);
  await withEnv({ SMS_PROVIDER: 'httpsms' }, async () => {
    const error = await auth.requestOtp('+919876500010', '10.2.0.8').catch((e) => e);
    assert.equal(error.code, 'MOBILE_DISABLED', 'SMS_PROVIDER=httpsms leaves mobile features off (no httpSMS fallback)');
  });
});

test('auth: staff accounts still cannot sign in with a customer code', { skip }, async () => {
  await makeUser('scanner', '+919876500011');
  const req = await auth.requestOtp('+919876500011', '10.2.0.9');
  await assert.rejects(auth.verifyOtp(req.challengeId, smsCode()), /Staff accounts sign in/);
});

// ---- CONTACT VALIDATION -----------------------------------------------------------------------------

test('contact 11/22: email-only customer buys, gets ONE email with the secure link + card instruction, no SMS', { skip }, async () => {
  const user = await makeUser('customer', 'emailonly@tickets.test', { mobile: null });
  const { co } = await buy(user, [2]);
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
  await deliver();
  const [bookingId] = await bookingsOf(co.id);
  const mail = emailsTo(user.contact);
  assert.equal(mail.length, 1);
  assert.ok(mail[0].text.includes(`Your QR tickets: https://staging.tickets.test/tickets/${bookingId}`), 'link to that booking’s QR page');
  assert.ok(mail[0].text.includes(CARDS));
  assert.ok(mail[0].text.includes('Your booking is confirmed! View your QR tickets using the secure link below.'));
  assert.equal(fake.sms.length, 0);
  assert.equal((await query("SELECT count(*)::int n FROM jobs WHERE kind='NOTIFY'"))[0].n, 0, 'no SMS job for an email-only account');
});

test('contact 12/23: mobile-only customer buys, gets ONE MSG91 confirmation SMS with the booking link, no email', { skip }, async () => {
  const user = await makeUser('customer', '+919876500012');
  const { co } = await buy(user, [1]);
  await deliver();
  const [bookingId] = await bookingsOf(co.id);
  const sms = confirmSms('+919876500012');
  assert.equal(sms.length, 1);
  assert.equal(sms[0].variables.LINK, `https://staging.tickets.test/tickets/${bookingId}`);
  assert.equal(sms[0].variables.REFERENCE, co.reference);
  assert.equal(fake.emails.length, 0);
});

test('contact 14: an unproven mobile is never linked: a code requested but not verified does not join the email account', { skip }, async () => {
  const { requestMobileVerification, verifiedContacts } = await import('../src/lib/account-contacts');
  const emailUser = await makeUser('customer', 'pending@tickets.test', { mobile: null });
  await requestMobileVerification(emailUser.id, '+919876500014', '10.2.0.10');
  assert.equal((await verifiedContacts(emailUser.id)).mobile, null);
  // Someone signs in with that number: a separate account, never the email account.
  await query("UPDATE otp_challenges SET created_at=now()-interval '1 minute'");
  const req = await auth.requestOtp('+919876500014', '10.2.0.10');
  const session = await auth.verifyOtp(req.challengeId, smsCode());
  assert.notEqual(session.user.id, emailUser.id);
  const { ownedBookings } = await import('../src/lib/commerce');
  const { co } = await buy(emailUser, [1]);
  assert.deepEqual(await ownedBookings(session.user.id), [], 'the other account sees none of the email account’s bookings');
  assert.equal((await ownedBookings(emailUser.id)).length, 1);
  assert.ok(co.id);
});

// ---- PAYMENTS, TICKETS AND NOTIFICATIONS ------------------------------------------------------------

test('tickets 20/21/27/28: several tickets keep their own QR credential across webhook redelivery and notification retries', { skip }, async () => {
  const user = await makeUser('customer', undefined, { mobile: '+919876500020' });
  const { co, payment } = await buy(user, [3, 2]);
  const credentials = async () => (await query<{ ticket_id: string; encrypted_token: string }>(
    "SELECT c.ticket_id, c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id WHERE b.checkout_id=$1 AND c.status='ACTIVE' ORDER BY c.ticket_id", [co.id]));
  const first = await credentials();
  assert.equal(first.length, 5, 'one credential per ticket');
  assert.equal(new Set(first.map((c) => c.encrypted_token)).size, 5, 'no shared admission credential');
  await deliver();
  const hook = webhook('payment.captured', payment);
  await payments.ingestRazorpayWebhook(hook.body, hook.signature);
  await payments.ingestRazorpayWebhook(hook.body, hook.signature);
  await query("UPDATE jobs SET state='PENDING', run_at=now() WHERE kind IN ('DELIVERY','NOTIFY')");
  await deliver();
  assert.deepEqual(await credentials(), first, 'QR credentials unchanged');
  assert.equal((await query('SELECT count(*)::int n FROM bookings WHERE checkout_id=$1', [co.id]))[0].n, 2, 'no extra booking');
  assert.deepEqual([emailsTo(user.contact).length, confirmSms('+919876500020').length], [1, 1], 'one email + one SMS');
  // Two bookings in the order: the SMS links to the ticket list that shows both.
  assert.equal(confirmSms('+919876500020')[0].variables.LINK, 'https://staging.tickets.test/tickets');
});

test('notify 29: the card instruction is in the email and in the SMS wording (template text + local free-text default)', { skip }, async () => {
  const { DEFAULT_SMS_TEXT, renderSms } = await import('../src/lib/sms');
  assert.ok(DEFAULT_SMS_TEXT.includes(CARDS));
  const rendered = renderSms({ REFERENCE: 'R1', SHOW: 'Show', LINK: 'https://x/tickets/1', NAME: 'A' });
  assert.equal(rendered.text, `Your booking for Show is confirmed. View your QR tickets: https://x/tickets/1. ${CARDS} Booking: R1`);
  const user = await makeUser('customer', undefined, { mobile: '+919876500029' });
  await buy(user, [1]);
  await deliver();
  assert.ok(emailsTo(user.contact)[0].text.includes(CARDS));
});

test('notify 30: MSG91 and Resend both down → booking stays CONFIRMED; each channel recovers on retry exactly once', { skip }, async () => {
  const user = await makeUser('customer', undefined, { mobile: '+919876500030' });
  const { co } = await buy(user, [1]);
  fake.failSms = true; fake.failEmail = true;
  await deliver();
  assert.equal((await checkout.checkoutReceipt(user.id, co.id)).status, 'CONFIRMED');
  const errors = (await query<{ last_error: string }>('SELECT last_error FROM jobs WHERE last_error IS NOT NULL')).map((r) => r.last_error).join(' ');
  assert.ok(!/\+?91\d{10}|tickets\/[0-9a-f-]{36}/.test(errors), 'job errors hold no number or ticket link');
  fake.failSms = false; fake.failEmail = false;
  await query("UPDATE jobs SET run_at=now() WHERE state='PENDING'");
  await deliver();
  assert.deepEqual([emailsTo(user.contact).length, confirmSms('+919876500030').length], [1, 1]);
});

test('resend: a mobile-only customer’s "resend tickets" uses the approved MSG91 confirmation template', { skip }, async () => {
  const user = await makeUser('customer', '+919876500031');
  const { co } = await buy(user, [1]);
  const [bookingId] = await bookingsOf(co.id);
  const { deliverBooking } = await import('../src/lib/tickets');
  await deliverBooking(bookingId);
  assert.equal(confirmSms('+919876500031').length, 1);
  assert.equal(confirmSms('+919876500031')[0].variables.LINK, `https://staging.tickets.test/tickets/${bookingId}`);
});

test('notice: a show-cancellation notice to a mobile needs the MSG91 notice template; without it the job fails visibly', { skip }, async () => {
  const user = await makeUser('customer', '+919876500032');
  const { co } = await buy(user, [1]);
  const [bookingId] = await bookingsOf(co.id);
  await query("INSERT INTO jobs(kind,key,payload) VALUES('NOTICE','n1',$1)", [JSON.stringify({ bookingId, message: 'A performance you booked was cancelled.' })]);
  await jobs.processJobs();
  const job = (await query<{ state: string; last_error: string }>("SELECT state, last_error FROM jobs WHERE key='n1'"))[0];
  assert.equal(job.state, 'PENDING');
  assert.match(job.last_error, /MSG91_NOTICE_TEMPLATE_ID/);
  await withEnv({ MSG91_NOTICE_TEMPLATE_ID: 'tmpl-notice' }, async () => {
    await query("UPDATE jobs SET run_at=now() WHERE key='n1'");
    await jobs.processJobs();
  });
  const notice = fake.sms.filter((s) => s.templateId === 'tmpl-notice');
  assert.equal(notice.length, 1);
  assert.deepEqual(notice[0].variables, { REFERENCE: (await query<{ reference: string }>('SELECT reference FROM bookings WHERE id=$1', [bookingId]))[0].reference, LINK: `https://staging.tickets.test/tickets/${bookingId}` });
});

// ---- TICKET ACCESS ----------------------------------------------------------------------------------

test('access 31/33/35/36: the link’s booking opens only for its owner; its QR admits once at the gate', { skip }, async () => {
  const owner = await makeUser('customer', '+919876500033');
  const stranger = await makeUser('customer', 'stranger@tickets.test', { mobile: null });
  const show = await makeShow({ startsInMinutes: 30 });
  const co = await checkout.createCheckout(owner, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(owner, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, owner);
  await deliver();
  const link = confirmSms('+919876500033')[0].variables.LINK;
  const bookingId = link.split('/tickets/')[1];
  assert.match(bookingId, /^[0-9a-f-]{36}$/, 'random UUID, not a sequential id');
  const { ownedBookings } = await import('../src/lib/commerce');
  const mine = (await ownedBookings(owner.id, bookingId)) as { tickets: { id: string }[] }[];
  assert.equal(mine.length, 1);
  assert.equal(mine[0].tickets.length, 1);
  assert.deepEqual(await ownedBookings(stranger.id, bookingId), [], 'another customer cannot open it');
  await assert.rejects(checkout.checkoutReceipt(stranger.id, co.id));
  const { ticketPass } = await import('../src/lib/tickets');
  await assert.rejects(ticketPass(stranger, mine[0].tickets[0].id), /Access denied/);
  assert.match((await ticketPass(owner, mine[0].tickets[0].id)).qr, /^data:image\/png;base64,/, 'the QR renders for the owner');

  const scanner = await makeUser('scanner');
  await query(`INSERT INTO devices(id,name) VALUES('gate-one','Main') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO staff_scopes(user_id,show_id,gate,device_id) VALUES($1,$2,'gate-one','gate-one')`, [scanner.id, show.showId]);
  const { decrypt } = await import('../src/lib/security');
  const token = decrypt((await query<{ encrypted_token: string }>(
    "SELECT c.encrypted_token FROM credentials c WHERE c.ticket_id=$1 AND c.status='ACTIVE'", [mine[0].tickets[0].id]))[0].encrypted_token);
  const scan = () => admission.admit(scanner, { requestId: randomUUID(), ticketToken: token, showId: show.showId, gateId: 'gate-one', deviceId: 'gate-one' });
  assert.equal((await scan()).result, 'ADMITTED');
  assert.equal((await scan()).result, 'DENIED', 'already admitted');
});

// ---- SALES SAFETY -----------------------------------------------------------------------------------

test('sales 38/39: mobile switched on but MSG91 incomplete → mobile stays OFF (fail closed); email sales unaffected', { skip }, async () => {
  const show = await makeShow();
  const customer = await makeUser('customer', undefined, { mobile: null });
  for (const missing of ['MSG91_OTP_TEMPLATE_ID', 'MSG91_TEMPLATE_ID', 'MSG91_AUTH_KEY', 'SMS_PROVIDER']) {
    await withEnv({ [missing]: undefined }, async () => {
      assert.equal(env.mobileFeaturesEnabled(), false, missing);
      assert.deepEqual(env.configurationProblems(), [], 'customer sales do not depend on MSG91');
      assert.equal((await auth.requestOtp('+919876500038', '10.2.0.38').catch((e) => e)).code, 'MOBILE_DISABLED', missing);
    });
  }
  await withEnv({ MSG91_TEMPLATE_ID: undefined }, async () => {
    await checkout.createCheckout(customer, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID());
  });
  assert.equal(fake.sms.length, 0, 'no SMS provider call');
});

test('sales 40: configured MSG91 alone never opens sales: the operator switch still applies', { skip }, async () => {
  const show = await makeShow();
  const customer = await makeUser();
  assert.deepEqual(env.configurationProblems(), []);
  await withEnv({ ALLOW_PUBLIC_SALES: undefined }, async () => {
    await assert.rejects(checkout.createCheckout(customer, [{ productId: show.productId, quantity: 1, version: 1 }], randomUUID()));
  });
  assert.equal((await query('SELECT count(*)::int n FROM checkouts'))[0].n, 0);
});
