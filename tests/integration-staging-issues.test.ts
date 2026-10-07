/**
 * Regressions for the staging report (Oct 2026):
 *  A–C  cart amounts: every line's Razorpay order equals that line's server total;
 *       the orders together equal the cart total (500 + 250 = 750); a client
 *       cannot change any amount.
 *  D/E  repeated payment cancellation and retry (across hold expiry) never
 *       poison the cart; inventory is released and re-held correctly.
 *  F    mobile OTP through httpSMS (stubbed): payload, persistence, provider
 *       failure surfaced (never silent), and verification.
 * The checkout UI's per-line loop is reproduced exactly: one hold + one order per
 * cart line, a fresh checkout key per attempt (app/cart/checkout/page.tsx).
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, expireNow, makeShow, makeUser, pool, resetDatabase, useLiveStagingEnv } from './helpers/fixtures';
import type { User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
let commerce: typeof import('../src/lib/commerce');
let payments: typeof import('../src/lib/payments');
let auth: typeof import('../src/lib/auth');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  useLiveStagingEnv();
  fake.install();
  commerce = await import('../src/lib/commerce');
  payments = await import('../src/lib/payments');
  auth = await import('../src/lib/auth');
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

type CartLine = { productId: string; quantity: number };

/** One checkout attempt for one cart line, exactly as the checkout page does it. */
async function startLine(user: User, line: CartLine) {
  const hold = (await commerce.reserve(user, { productId: line.productId, quantity: line.quantity, version: 1 }, randomUUID())) as { id: string; total: number; status: string };
  const order = await payments.createPaymentOrder(user, hold.id);
  return { bookingId: hold.id, total: Number(hold.total), order };
}

async function pay(user: User, orderId: string) {
  const p = fake.pay(orderId);
  return payments.verifyRazorpayCallback({ razorpay_order_id: orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(orderId, p.id) }, user);
}

test('A: ₹500 + ₹250 cart: two server-priced orders (₹500, ₹250) summing to ₹750; both lines confirmed', { skip }, async () => {
  const premier = await makeShow({ price: 50000, allocation: 10 });
  const balcony = await makeShow({ price: 25000, allocation: 10 });
  const user = await makeUser();
  const cart: CartLine[] = [{ productId: premier.productId, quantity: 1 }, { productId: balcony.productId, quantity: 1 }];
  const started = [];
  for (const line of cart) started.push(await startLine(user, line));
  assert.deepEqual(started.map((s) => s.order.amount), [50000, 25000], 'each order is that line’s server total');
  assert.equal(started.reduce((sum, s) => sum + s.order.amount, 0), 75000, 'orders together equal the cart total');
  assert.deepEqual([...fake.orders.values()].map((o) => o.amount).sort(), [25000, 50000], 'Razorpay was asked for exactly those amounts');
  for (const s of started) assert.equal((await pay(user, s.order.orderId)).status, 'CONFIRMED');
  const rows = await query<{ status: string; total: number }>('SELECT status, total FROM bookings WHERE user_id=$1 ORDER BY total DESC', [user.id]);
  assert.deepEqual(rows.map((r) => [r.status, Number(r.total)]), [['CONFIRMED', 50000], ['CONFIRMED', 25000]]);
  const paid = await query<{ n: number }>('SELECT COALESCE(SUM(amount),0)::int n FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.user_id=$1', [user.id]);
  assert.equal(paid[0].n, 75000, 'captured money equals the cart total');
  assert.equal((await pool(premier.poolId)).committed, 1);
  assert.equal((await pool(balcony.poolId)).committed, 1);
});

test('B: single ₹500 ticket → one ₹500 order', { skip }, async () => {
  const show = await makeShow({ price: 50000 });
  const user = await makeUser();
  const s = await startLine(user, { productId: show.productId, quantity: 1 });
  assert.equal(s.order.amount, 50000);
  assert.equal((await pay(user, s.order.orderId)).status, 'CONFIRMED');
});

test('C: 2 × ₹500 → one ₹1000 order and two tickets', { skip }, async () => {
  const show = await makeShow({ price: 50000 });
  const user = await makeUser();
  const s = await startLine(user, { productId: show.productId, quantity: 2 });
  assert.equal(s.order.amount, 100000);
  await pay(user, s.order.orderId);
  assert.equal((await query('SELECT 1 FROM tickets WHERE booking_id=$1', [s.bookingId])).length, 2);
});

test('a payment below the server total is rejected (client cannot underpay)', { skip }, async () => {
  const show = await makeShow({ price: 50000 });
  const user = await makeUser();
  const s = await startLine(user, { productId: show.productId, quantity: 1 });
  const p = fake.pay(s.order.orderId, { amount: 25000 });
  await assert.rejects(
    () => payments.verifyRazorpayCallback({ razorpay_order_id: s.order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(s.order.orderId, p.id) }, user),
    /does not match/,
  );
  assert.equal((await query('SELECT status FROM bookings WHERE id=$1', [s.bookingId]))[0].status, 'PAYMENT_PENDING');
});

test('D: cancel → retry → cancel → retry → cancel → retry (two lines) keeps one hold/order per line, then pays', { skip }, async () => {
  const premier = await makeShow({ price: 50000, allocation: 5 });
  const balcony = await makeShow({ price: 25000, allocation: 5 });
  const user = await makeUser();
  const cart: CartLine[] = [{ productId: premier.productId, quantity: 1 }, { productId: balcony.productId, quantity: 1 }];
  let last: Awaited<ReturnType<typeof startLine>>[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Each "Proceed to pay" walks every line; dismissing the modal is purely client-side.
    last = [];
    for (const line of cart) last.push(await startLine(user, line));
  }
  assert.equal(new Set(last.map((s) => s.bookingId)).size, 2);
  assert.equal(fake.orders.size, 2, 'retries reuse the live order, no duplicate Razorpay orders');
  assert.equal((await pool(premier.poolId)).held, 1, 'no inventory leak from retries');
  assert.equal((await pool(balcony.poolId)).held, 1);
  for (const s of last) assert.equal((await pay(user, s.order.orderId)).status, 'CONFIRMED');
});

test('E: retries spanning hold expiry release the old hold and create a valid new one (cart never poisoned)', { skip }, async () => {
  const show = await makeShow({ price: 25000, allocation: 1 });
  const user = await makeUser();
  const line = { productId: show.productId, quantity: 1 };
  const first = await startLine(user, line);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await expireNow(first.bookingId);
    await query("UPDATE bookings SET expires_at=now() - interval '1 second' WHERE user_id=$1 AND status IN ('HELD','PAYMENT_PENDING')", [user.id]);
    await commerce.expireHolds();
    assert.equal((await pool(show.poolId)).held, 0, 'expired hold released (seat available again)');
    const retry = await startLine(user, line);
    assert.equal(retry.order.amount, 25000);
    assert.equal((await pool(show.poolId)).held, 1);
  }
  const final = await startLine(user, line);
  assert.equal((await pay(user, final.order.orderId)).status, 'CONFIRMED');
  assert.deepEqual(await pool(show.poolId), { allocation: 1, held: 0, committed: 1 });
  // Abandoned orders from the expired holds never confirm anything if paid late: they refund (no seat left).
  const stale = [...fake.orders.values()].find((o) => o.id !== final.order.orderId)!;
  const late = fake.pay(stale.id);
  const { body, signature } = (await import('./helpers/fixtures')).webhook('payment.captured', late);
  await payments.ingestRazorpayWebhook(body, signature);
  assert.equal((await pool(show.poolId)).committed, 1, 'inventory never double-allocated');
  assert.equal((await query("SELECT count(*)::int n FROM refunds"))[0].n, 1);
});

/* ---------- F: mobile OTP via httpSMS (provider stubbed, no real credentials) ---------- */

function withHttpsms(respond: (body: Record<string, unknown>) => Response) {
  const previous = { OTP_PROVIDER: process.env.OTP_PROVIDER, HTTPSMS_API_KEY: process.env.HTTPSMS_API_KEY, HTTPSMS_FROM: process.env.HTTPSMS_FROM };
  Object.assign(process.env, { OTP_PROVIDER: 'httpsms', HTTPSMS_API_KEY: 'stub-key', HTTPSMS_FROM: '+91 91112 22333' });
  const sent: Record<string, unknown>[] = [];
  const underlying = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.httpsms.com/v1/messages/send') {
      const body = JSON.parse(String(init?.body));
      assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'stub-key');
      sent.push(body);
      return respond(body);
    }
    return underlying(input, init);
  }) as typeof fetch;
  return {
    sent,
    restore() {
      globalThis.fetch = underlying;
      for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    },
  };
}

test('F: mobile OTP is sent through httpSMS, stored hashed, and verifies', { skip }, async () => {
  const sms = withHttpsms(() => new Response(JSON.stringify({ status: 'success', data: { id: 'msg_1', status: 'pending' } }), { status: 200 }));
  try {
    const res = await auth.requestOtp('98765 43210', '10.1.1.1');
    assert.equal(sms.sent.length, 1);
    assert.deepEqual({ from: sms.sent[0].from, to: sms.sent[0].to }, { from: '+919111222333', to: '+919876543210' });
    assert.equal('developmentCode' in res, false, 'live mode never returns the code');
    const row = (await query<{ contact: string; digest: string }>('SELECT contact, digest FROM otp_challenges WHERE id=$1', [res.challengeId]))[0];
    const code = /code: (\d{6})/.exec(String(sms.sent[0].content))![1];
    assert.equal(row.contact, '+919876543210');
    assert.ok(!row.digest.includes(code), 'stored as a keyed hash, not the code');
    await assert.rejects(() => auth.verifyOtp(res.challengeId, code === '000000' ? '111111' : '000000'), /incorrect/i);
    const session = await auth.verifyOtp(res.challengeId, code);
    assert.equal(session.user.contact, '+919876543210');
  } finally {
    sms.restore();
  }
});

test('F: an httpSMS rejection is reported to the user, never a silent "code sent"', { skip }, async () => {
  // The provider echoes the recipient and the message text back in its error.
  const sms = withHttpsms((body) => new Response(JSON.stringify({ status: 'error', message: `cannot deliver to ${body.to}: ${body.content}` }), { status: 400 }));
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); };
  try {
    await assert.rejects(() => auth.requestOtp('+919876543211', '10.1.1.2'), /SMS delivery is temporarily unavailable/);
  } finally {
    console.error = originalError;
    sms.restore();
  }
  const line = logged.find((l) => l.startsWith('httpsms send failed'));
  assert.ok(line, 'provider failure is logged for diagnosis');
  assert.ok(!/9876543211/.test(line!), 'no phone number in logs');
  const code = /code: (\d{6})/.exec(String(sms.sent[0].content))![1];
  assert.ok(!line!.includes(code), 'no OTP in logs');
  assert.ok(line!.includes('[redacted]'));
});

test('provider text is redacted before logging (phone numbers in any spacing, OTP codes)', async () => {
  const { redactDigits } = await import('../src/lib/httpsms');
  assert.equal(redactDigits('invalid number +91 98765 43210'), 'invalid number [redacted]');
  assert.equal(redactDigits('to=+919876543210 code 123456'), 'to=[redacted] code [redacted]');
  assert.doesNotMatch(redactDigits('(033) 2345-6789'), /\d/, 'no digit of a landline survives');
  assert.equal(redactDigits('rate limit 429, retry in 30s'), 'rate limit 429, retry in 30s', 'short numbers stay for diagnosis');
});

test('F: email OTP is unaffected by the SMS configuration', { skip }, async () => {
  const sms = withHttpsms(() => new Response('{}', { status: 200 }));
  try {
    await auth.requestOtp('buyer@tickets.test', '10.1.1.3');
    assert.equal(sms.sent.length, 0, 'email never goes to the SMS gateway');
    assert.ok(fake.emails.some((e) => e.to === 'buyer@tickets.test'));
  } finally {
    sms.restore();
  }
});
