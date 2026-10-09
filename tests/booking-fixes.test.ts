import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/errors';
import { assertLiveConfiguration, configurationProblems, developmentAdaptersAllowed, isLocalAppUrl, mobileConfigurationProblems, mobileFeaturesEnabled } from '../src/lib/env';
import { safeNextPath } from '../src/lib/redirect';
import { gateScanTarget } from '../src/lib/gates';
import { entryAllowed } from '../src/lib/admission';
import { confirmationLinks } from '../src/lib/tickets';
import { festivalLimits, resolveEnabled } from '../src/lib/catalogue';
import { nextReconcileDelayMinutes, RECONCILE_MAX_BACKOFF_MINUTES } from '../src/lib/payments';
import { clerkFrontendHost } from '../src/lib/security-headers';
import { refundStateFromProvider } from '../src/lib/refunds';
import { assertBookingIssued } from '../src/lib/razorpay-checkout';
import { PRUNE_SQL, STALE_JOB_MINUTES } from '../src/lib/jobs';
import { SECURITY_HEADER_LIST } from '../src/lib/security-headers';

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const LIVE_STAGING = {
  APP_MODE: 'live',
  DEPLOY_ENV: 'staging',
  APP_URL: 'https://staging.example.workers.dev',
  DATABASE_URL: 'postgresql://x@db.example/x',
  SESSION_SECRET: 's'.repeat(40),
  CREDENTIAL_KEY: 'k'.repeat(40),
  CRON_SECRET: 'c'.repeat(20),
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_abc',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
  OTP_PROVIDER: 'email',
  // A verified mobile is required to buy, so live mode needs SMS delivery (test values, never sent).
  SMS_PROVIDER: 'msg91',
  MSG91_AUTH_KEY: 'test-auth-key',
  MSG91_TEMPLATE_ID: 'test-template',
  MSG91_OTP_TEMPLATE_ID: 'test-otp-template',
  RESEND_API_KEY: 're_x',
  EMAIL_FROM: 'tickets@example.org',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
  CLERK_SECRET_KEY: 'sk_test_x',
};

test('an unset APP_URL is NOT local (fails closed)', () => {
  assert.equal(isLocalAppUrl(''), false);
  assert.equal(isLocalAppUrl('not a url'), false);
});

test('public hosts are not treated as local', () => {
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
      (err: unknown) => err instanceof AppError && err.status === 503 && err.code === 'CONFIG_INVALID',
    );
  } finally {
    process.env.APP_MODE = previous.APP_MODE;
    process.env.APP_URL = previous.APP_URL;
    process.env.PAYMENT_PROVIDER = previous.PAYMENT_PROVIDER;
    process.env.OTP_PROVIDER = previous.OTP_PROVIDER;
  }
});

test('development mode with APP_URL missing is refused, not treated as local', () => {
  withEnv({ APP_MODE: 'development', APP_URL: undefined }, () => {
    assert.equal(developmentAdaptersAllowed(), false);
    assert.throws(() => assertLiveConfiguration(), (err: unknown) => err instanceof AppError && err.status === 503);
  });
  withEnv({ APP_MODE: 'development', APP_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://festival:x@127.0.0.1:54329/festival' }, () => {
    assert.equal(developmentAdaptersAllowed(), true);
    assert.doesNotThrow(() => assertLiveConfiguration());
  });
});

test('development adapters refuse a remote database (laptop .env.local pointed at production)', () => {
  withEnv({ APP_MODE: 'development', APP_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/prod' }, () => {
    assert.equal(developmentAdaptersAllowed(), false);
    assert.throws(() => assertLiveConfiguration(), (err: unknown) => err instanceof AppError && err.status === 503);
  });
});

test('an unknown APP_MODE is live, never development', () => {
  withEnv({ ...LIVE_STAGING, APP_MODE: 'devlopment' }, () => {
    assert.equal(developmentAdaptersAllowed(), false);
    assert.deepEqual(configurationProblems(), []);
  });
});

test('live mode lists every missing production requirement by name only', () => {
  withEnv({ ...LIVE_STAGING }, () => assert.deepEqual(configurationProblems(), []));
  withEnv({ ...LIVE_STAGING, RAZORPAY_WEBHOOK_SECRET: undefined }, () => assert.ok(configurationProblems().includes('RAZORPAY_WEBHOOK_SECRET')));
  withEnv({ ...LIVE_STAGING, APP_URL: undefined }, () => assert.ok(configurationProblems().some((p) => p.startsWith('APP_URL'))));
  withEnv({ ...LIVE_STAGING, APP_URL: 'http://localhost:3000' }, () => assert.ok(configurationProblems().some((p) => p.startsWith('APP_URL'))));
  withEnv({ ...LIVE_STAGING, PAYMENT_PROVIDER: 'development' }, () => assert.ok(configurationProblems().includes('PAYMENT_PROVIDER=razorpay')));
  withEnv({ ...LIVE_STAGING, OTP_PROVIDER: 'development' }, () => assert.ok(configurationProblems().some((p) => p.startsWith('OTP_PROVIDER'))));
  withEnv({ ...LIVE_STAGING, DEPLOY_ENV: undefined }, () => assert.ok(configurationProblems().some((p) => p.startsWith('DEPLOY_ENV'))));
  withEnv({ ...LIVE_STAGING, DEPLOY_ENV: 'production' }, () => assert.ok(configurationProblems().some((p) => /live key/.test(p))));
  withEnv({ ...LIVE_STAGING, RAZORPAY_KEY_ID: 'rzp_live_abc' }, () => assert.ok(configurationProblems().some((p) => /test key/.test(p))));
  withEnv({ ...LIVE_STAGING, RESEND_API_KEY: undefined }, () => assert.ok(configurationProblems().some((p) => p.startsWith('email'))));
  withEnv({ ...LIVE_STAGING, CLERK_SECRET_KEY: undefined }, () => assert.ok(configurationProblems().includes('CLERK_SECRET_KEY')));
  withEnv({ ...LIVE_STAGING, OTP_PROVIDER: 'httpsms' }, () => assert.ok(configurationProblems().some((p) => p.startsWith('OTP_PROVIDER'))));
  // MSG91 is not a sales requirement (email-only sales); with mobile switched on it is the only
  // provider and each template is required, else mobile features stay off (fail closed).
  withEnv({ ...LIVE_STAGING, SMS_PROVIDER: undefined, MSG91_AUTH_KEY: undefined }, () => assert.deepEqual(configurationProblems(), []));
  withEnv({ ...LIVE_STAGING, MOBILE_PHONE_NUMBER_ENABLED: 'true', SMS_PROVIDER: 'httpsms', HTTPSMS_API_KEY: 'k', HTTPSMS_FROM: '+919111222333' }, () => {
    assert.ok(mobileConfigurationProblems().includes('SMS_PROVIDER=msg91'), 'httpSMS is not a live provider');
    assert.equal(mobileFeaturesEnabled(), false);
  });
  for (const name of ['MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID', 'MSG91_TEMPLATE_ID']) {
    withEnv({ ...LIVE_STAGING, MOBILE_PHONE_NUMBER_ENABLED: 'true', [name]: undefined }, () => {
      assert.ok(mobileConfigurationProblems().includes(name), name);
      assert.equal(mobileFeaturesEnabled(), false, name);
    });
  }
  withEnv({ ...LIVE_STAGING, MOBILE_PHONE_NUMBER_ENABLED: 'true' }, () => assert.equal(mobileFeaturesEnabled(), true));
  withEnv({ ...LIVE_STAGING, SESSION_SECRET: 'short' }, () => assert.ok(configurationProblems().some((p) => p.startsWith('SESSION_SECRET'))));
  // Problems name settings, never their values.
  withEnv({ ...LIVE_STAGING, SESSION_SECRET: 'short-secret-value' }, () => assert.ok(!configurationProblems().join(' ').includes('short-secret-value')));
});

test('development adapters are refused on Cloudflare Workers even with a localhost APP_URL', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Cloudflare-Workers' }, configurable: true });
  try {
    withEnv({ APP_MODE: 'development', APP_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://festival:x@127.0.0.1:54329/festival' }, () => assert.equal(developmentAdaptersAllowed(), false));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('Clerk Frontend API host is derived from the publishable key for CSP', () => {
  const key = 'pk_live_' + Buffer.from('clerk.samatat.org$').toString('base64');
  assert.equal(clerkFrontendHost(key), 'clerk.samatat.org');
  assert.equal(clerkFrontendHost('nonsense'), null);
});

test('refund state follows the provider, never optimistic', () => {
  assert.equal(refundStateFromProvider('processed'), 'SUCCEEDED');
  assert.equal(refundStateFromProvider('failed'), 'FAILED');
  assert.equal(refundStateFromProvider('pending'), 'PROCESSING');
  assert.equal(refundStateFromProvider(undefined), 'PROCESSING');
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

test('reconciliation backs off abandoned orders but re-checks live ones every minute', () => {
  assert.equal(nextReconcileDelayMinutes(0, true), 1);
  assert.equal(nextReconcileDelayMinutes(0, false), 2, 'just expired: checked again within minutes');
  assert.equal(nextReconcileDelayMinutes(60, false), 15);
  assert.equal(nextReconcileDelayMinutes(7 * 24 * 60, false), RECONCILE_MAX_BACKOFF_MINUTES);
});

test('a refund-required payment is not treated as a confirmed booking', () => {
  assert.throws(() => assertBookingIssued({ status: 'REFUND_REQUIRED' }), /REFUND_REQUIRED/);
  assert.throws(() => assertBookingIssued({ status: 'CANCELLED' }), /REFUND_REQUIRED/);
  assert.throws(() => assertBookingIssued({ status: 'REFUNDED' }), /REFUND_REQUIRED/);
  // HTTP 200 with any non-confirmed state is not success.
  assert.throws(() => assertBookingIssued({ status: 'PAYMENT_PENDING' }), /being checked/);
  assert.throws(() => assertBookingIssued({}), /being checked/);
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
  assert.ok(csp?.value.includes("worker-src 'self' blob:"));
});
