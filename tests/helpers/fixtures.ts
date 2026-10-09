/**
 * Database fixtures for integration tests. They TRUNCATE tables, so they
 * refuse anything but a loopback DATABASE_URL (local embedded Postgres or
 * the CI service container).
 */
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { query, transaction, one } from '../../src/lib/db';
import type { User } from '../../src/lib/types';

export const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);

export const TEST_SECRETS = {
  RAZORPAY_KEY_ID: 'rzp_test_integration',
  RAZORPAY_KEY_SECRET: 'integration-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'integration-webhook-secret',
};

/** A complete live-mode (staging) configuration. Payments go to the fake Razorpay. */
export function useLiveStagingEnv() {
  Object.assign(process.env, {
    APP_MODE: 'live',
    DEPLOY_ENV: 'staging',
    APP_URL: 'https://staging.tickets.test',
    SESSION_SECRET: process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : 'integration-session-secret-0123456789abcdef',
    CREDENTIAL_KEY: process.env.CREDENTIAL_KEY && process.env.CREDENTIAL_KEY.length >= 32 ? process.env.CREDENTIAL_KEY : 'integration-credential-key-0123456789abcdef',
    CRON_SECRET: 'integration-cron-secret-0123',
    PAYMENT_PROVIDER: 'razorpay',
    OTP_PROVIDER: 'email',
    RESEND_API_KEY: 're_integration',
    EMAIL_FROM: 'tickets@tickets.test',
    ALLOW_PUBLIC_SALES: 'true',
    // SMS goes to the fake MSG91 (tests/helpers/fake-razorpay.ts); nothing is really sent.
    // Mobile features ON here so the existing SMS tests run; the flag-off journey is tested in integration-mobile-flag.test.ts.
    MOBILE_PHONE_NUMBER_ENABLED: 'true',
    SMS_PROVIDER: 'msg91',
    MSG91_AUTH_KEY: 'test-auth-key',
    MSG91_TEMPLATE_ID: 'tmpl-confirm',
    MSG91_OTP_TEMPLATE_ID: 'tmpl-otp',
    DB_POOL_MAX: '10',
    ...TEST_SECRETS,
  });
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';
  process.env.CLERK_SECRET_KEY = 'sk_test_integration';
}

export function assertLoopbackDatabase() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://none').hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Integration tests truncate tables; refusing DATABASE_URL host ${host}.`);
  }
}

export async function resetDatabase() {
  assertLoopbackDatabase();
  await query(`TRUNCATE admissions, scan_requests, entitlements, physical_issues, credentials, tickets, refunds, payments,
    payment_attempts, hold_allocations, booking_attempts, bookings, product_coverage, movements, pools, capacities, products,
    staff_scopes, devices, shows, festivals, sessions, otp_challenges, rate_limits, idempotency, jobs, reconciliation_cases,
    webhook_events, audit_events, notification_deliveries, users RESTART IDENTITY CASCADE`);
}

export async function makeFestival() {
  return (await query<{ id: string }>(
    `INSERT INTO festivals(name,name_bn,venue,address,status,contact_email,terms,capacity_approved,policies_approved)
     VALUES('Test Festival','টেস্ট','Ganabhawan','Uttarpara','PUBLISHED','tickets@tickets.test','Terms',true,true) RETURNING id`,
  ))[0];
}

export async function makeShow(opts: { startsInMinutes?: number; allocation?: number; price?: number; title?: string } = {}) {
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0] ?? (await makeFestival());
  const startsAt = new Date(Date.now() + (opts.startsInMinutes ?? 7 * 24 * 60) * 60_000);
  const endsAt = new Date(startsAt.getTime() + 120 * 60_000);
  return transaction(async (c) => {
    const show = (await one<{ id: string }>(
      c,
      `INSERT INTO shows(festival_id,title,title_bn,troupe,synopsis,synopsis_bn,starts_at,ends_at,runtime,genre,status)
       VALUES($1,$2,$2,'Troupe','Synopsis','Synopsis',$3,$4,120,'Drama','PUBLISHED') RETURNING id`,
      [festival.id, opts.title ?? 'Play ' + randomUUID().slice(0, 6), startsAt.toISOString(), endsAt.toISOString()],
    ))!;
    const capacity = (await one<{ id: string }>(c, "INSERT INTO capacities(show_id,zone,ceiling) VALUES($1,'Premier',$2) RETURNING id", [show.id, 500]))!;
    const pool = (await one<{ id: string }>(
      c,
      "INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'DAILY',$2,1,10) RETURNING id",
      [capacity.id, opts.allocation ?? 10],
    ))!;
    const seasonPool = (await one<{ id: string }>(
      c,
      "INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'SEASON',$2,11,12) RETURNING id",
      [capacity.id, 50],
    ))!;
    const product = (await one<{ id: string }>(
      c,
      `INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id) VALUES($1,'Premier daily','প্রিমিয়ার','Premier','DAILY',$2,$3) RETURNING id`,
      [festival.id, opts.price ?? 50000, show.id],
    ))!;
    await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [product.id, show.id, pool.id]);
    return { showId: show.id, poolId: pool.id, seasonPoolId: seasonPool.id, productId: product.id, version: 1, price: opts.price ?? 50000 };
  });
}

/** A SEASON product covering the given shows' season pools. */
export async function makeSeason(shows: { showId: string; seasonPoolId: string }[], price = 200000) {
  const festival = (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0];
  const product = (await query<{ id: string }>(
    `INSERT INTO products(festival_id,name,name_bn,category,kind,price) VALUES($1,'Season','মৌসুম','Premier','SEASON',$2) RETURNING id`,
    [festival.id, price],
  ))[0];
  for (const s of shows) await query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [product.id, s.showId, s.seasonPoolId]);
  return { productId: product.id, version: 1, price };
}

let mobileCounter = 0;
/**
 * A user. An email account gets a verified mobile by default (a verified mobile is
 * required to buy); pass `{ mobile: null }` for an email-only account. A mobile
 * account (contact '+91…') is its own verified mobile.
 */
export async function makeUser(role: User['role'] = 'customer', contact = `${role}-${randomUUID().slice(0, 8)}@tickets.test`, opts: { mobile?: string | null } = {}): Promise<User> {
  const mobile = contact.includes('@') && opts.mobile !== null
    ? opts.mobile ?? `+9197${String(process.pid % 1000).padStart(3, '0')}${String(mobileCounter++).padStart(5, '0')}`
    : null;
  return (await query<User>('INSERT INTO users(contact,name,role,verified_mobile,mobile_verified_at) VALUES($1,$2,$3,$4,CASE WHEN $4::text IS NULL THEN NULL ELSE now() END) RETURNING id,contact,name,role',
    [contact, role, role, mobile]))[0];
}

export async function pool(poolId: string) {
  return (await query<{ allocation: number; held: number; committed: number }>('SELECT allocation,held,committed FROM pools WHERE id=$1', [poolId]))[0];
}

export async function booking(id: string) {
  return (await query<{ id: string; status: string; total: number; expires_at: string }>('SELECT * FROM bookings WHERE id=$1', [id]))[0];
}

export async function expireNow(bookingId: string) {
  await query("UPDATE bookings SET expires_at=now() - interval '1 second' WHERE id=$1", [bookingId]);
}

export function checkoutSignature(orderId: string, paymentId: string) {
  return createHmac('sha256', TEST_SECRETS.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

export function webhook(event: string, entity: Record<string, unknown>, kind: 'payment' | 'refund' = 'payment', eventId = 'evt_' + randomUUID()) {
  const body = JSON.stringify({ id: eventId, event, created_at: Math.floor(Date.now() / 1000), payload: { [kind]: { entity } } });
  const signature = createHmac('sha256', TEST_SECRETS.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  return { body, signature };
}
