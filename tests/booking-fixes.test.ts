import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/errors';
import { assertLiveConfiguration, isLocalAppUrl } from '../src/lib/env';
import { safeNextPath } from '../src/lib/redirect';
import { gateScanTarget } from '../src/lib/gates';
import { entryAllowed } from '../src/lib/admission';
import { confirmationLinks } from '../src/lib/tickets';
import { festivalLimits, resolveEnabled } from '../src/lib/catalogue';
import { holdIdempotencyKey } from '../src/lib/commerce';
import { RECONCILE_OPEN_ORDERS_SQL } from '../src/lib/payments';
import { assertBookingIssued } from '../src/lib/razorpay-checkout';
import { PRUNE_SQL, STALE_JOB_MINUTES } from '../src/lib/jobs';
import { SECURITY_HEADER_LIST } from '../src/lib/security-headers';

test('public hosts are not treated as local', () => {
  assert.equal(isLocalAppUrl(''), true);
  assert.equal(isLocalAppUrl('http://localhost:3000'), true);
  assert.equal(isLocalAppUrl('http://127.0.0.1:3000'), true);
  assert.equal(isLocalAppUrl('https://ganabhawan-festival.example.workers.dev'), false);
});

test('development adapters are refused on a public host', () => {
  const previous = {
    APP_MODE: process.env.APP_MODE,
    APP_URL: process.env.APP_URL,
    PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
    OTP_PROVIDER: process.env.OTP_PROVIDER,
  };
  process.env.APP_MODE = 'development';
  process.env.APP_URL = 'https://ganabhawan-festival.example.workers.dev';
  process.env.PAYMENT_PROVIDER = 'development';
  process.env.OTP_PROVIDER = 'development';
  try {
    assert.throws(
      () => assertLiveConfiguration(),
      (err: unknown) => err instanceof AppError && err.status === 503 && /public host/i.test(err.message),
    );
  } finally {
    process.env.APP_MODE = previous.APP_MODE;
    process.env.APP_URL = previous.APP_URL;
    process.env.PAYMENT_PROVIDER = previous.PAYMENT_PROVIDER;
    process.env.OTP_PROVIDER = previous.OTP_PROVIDER;
  }
});

test('razorpay checkout is allowed on a public host while the app mode is development', () => {
  const previous = {
    APP_MODE: process.env.APP_MODE,
    APP_URL: process.env.APP_URL,
    PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
    OTP_PROVIDER: process.env.OTP_PROVIDER,
  };
  process.env.APP_MODE = 'development';
  process.env.APP_URL = 'https://ganabhawan-festival.example.workers.dev';
  process.env.PAYMENT_PROVIDER = 'razorpay';
  process.env.OTP_PROVIDER = 'development';
  try {
    assert.doesNotThrow(() => assertLiveConfiguration());
  } finally {
    process.env.APP_MODE = previous.APP_MODE;
    process.env.APP_URL = previous.APP_URL;
    process.env.PAYMENT_PROVIDER = previous.PAYMENT_PROVIDER;
    process.env.OTP_PROVIDER = previous.OTP_PROVIDER;
  }
});

test('login next path stays on this site', () => {
  assert.equal(safeNextPath('/tickets'), '/tickets');
  assert.equal(safeNextPath('https://evil.example/phish'), '/catalogue');
  assert.equal(safeNextPath('//evil.example'), '/catalogue');
  assert.equal(safeNextPath(null, '/admin'), '/admin');
});

test('gate scan uses a seeded device, not gate main', () => {
  assert.deepEqual(gateScanTarget('main'), { gateId: 'gate-one', deviceId: 'gate-one' });
  assert.deepEqual(gateScanTarget('gate-two'), { gateId: 'gate-two', deviceId: 'gate-two' });
});

test('entry window follows festival minutes around the start', () => {
  const start = Date.parse('2026-10-03T18:00:00.000Z');
  assert.equal(entryAllowed(start - 59 * 60_000, new Date(start).toISOString(), 60, 15), true);
  assert.equal(entryAllowed(start - 61 * 60_000, new Date(start).toISOString(), 60, 15), false);
  assert.equal(entryAllowed(start + 16 * 60_000, new Date(start).toISOString(), 60, 15), false);
});

test('confirmation links use the booking id', () => {
  const links = confirmationLinks('https://tickets.example', 'booking-1', ['GF-1']);
  assert.match(links, /\/tickets\/booking-1$/);
  assert.doesNotMatch(links, /ticket-row/);
});

test('partial product updates keep the current enabled flag', () => {
  assert.equal(resolveEnabled(true, undefined), true);
  assert.equal(resolveEnabled(true, false), false);
});

test('festival numeric fields are rejected before the database', () => {
  const current = { holdMinutes: 10, maxQuantity: 6, entryBefore: 60, entryAfter: 15 };
  assert.throws(
    () => festivalLimits({ holdMinutes: 'nope' }, current),
    (err: unknown) => err instanceof AppError && err.status === 400,
  );
  assert.deepEqual(festivalLimits({ holdMinutes: 12 }, current).holdMinutes, 12);
});

test('hold idempotency key is stable for the same selection', () => {
  const key = holdIdempotencyKey('prod', 2, 3);
  assert.equal(key, holdIdempotencyKey('prod', 2, 3));
  assert.ok(key.length >= 8 && key.length <= 128);
});

test('reconciliation includes expired bookings and ignores expiry time', () => {
  assert.match(RECONCILE_OPEN_ORDERS_SQL, /EXPIRED/);
  assert.doesNotMatch(RECONCILE_OPEN_ORDERS_SQL, /expires_at >/);
});

test('a refund-required payment is not treated as a confirmed booking', () => {
  assert.throws(() => assertBookingIssued({ status: 'REFUND_REQUIRED' }), /REFUND_REQUIRED/);
  assert.deepEqual(assertBookingIssued({ status: 'CONFIRMED' }), { status: 'CONFIRMED' });
});

test('housekeeping reclaims stale jobs and prunes operational tables', () => {
  assert.equal(STALE_JOB_MINUTES, 15);
  assert.ok(PRUNE_SQL.some((sql) => sql.includes('rate_limits')));
  assert.ok(PRUNE_SQL.some((sql) => sql.includes('idempotency')));
  assert.ok(PRUNE_SQL.some((sql) => sql.includes('scan_requests')));
});

test('security headers include a content security policy', () => {
  const csp = SECURITY_HEADER_LIST.find((header) => header.key === 'Content-Security-Policy');
  assert.ok(csp?.value.includes("default-src 'self'"));
  assert.ok(csp?.value.includes('checkout.razorpay.com'));
  assert.ok(csp?.value.includes('https://challenges.cloudflare.com'));
  assert.ok(csp?.value.includes('https://*.protect.clerk.com:*'));
  assert.ok(csp?.value.includes("worker-src 'self' blob:"));
});
