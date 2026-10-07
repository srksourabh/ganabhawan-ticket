/**
 * READ-ONLY money/inventory/ticket invariant check + Razorpay cross-check.
 * Run against STAGING after each step of the test-mode drill
 * (docs/STAGING_DRILL.md), and against PRODUCTION as a smoke test.
 * It never writes to the database or calls a mutating Razorpay endpoint.
 *
 *   npm run drill:razorpay                 # DB invariants + last 200 orders vs Razorpay
 *   npm run drill:razorpay -- GF-1A2B3C4D  # also print one booking's full trail
 *
 * Needs DATABASE_URL, and RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET for the cross-check
 * (test keys for staging). Prints ids and counts only, never contacts or secrets.
 */
import { config } from 'dotenv';
config({ path: process.env.ENV_FILE || '.env.local', quiet: true });

import { pool, query } from '../src/lib/db';
import { razorpayListOrderPayments } from '../src/lib/razorpay';

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, rows: unknown[], detail = `${rows.length} violation(s)`) => checks.push({ name, ok: rows.length === 0, detail: rows.length ? `${detail}: ${JSON.stringify(rows.slice(0, 5))}` : 'ok' });

try {
  await query('BEGIN READ ONLY').catch(() => undefined);

  check('pool counters equal live allocations', await query(`
    SELECT p.id, p.held, p.committed,
      COALESCE(SUM(h.quantity) FILTER (WHERE h.state='HELD'),0)::int AS live_held,
      COALESCE(SUM(h.quantity) FILTER (WHERE h.state='COMMITTED'),0)::int AS live_committed
    FROM pools p LEFT JOIN hold_allocations h ON h.pool_id=p.id
    GROUP BY p.id HAVING p.held <> COALESCE(SUM(h.quantity) FILTER (WHERE h.state='HELD'),0)
      OR p.committed <> COALESCE(SUM(h.quantity) FILTER (WHERE h.state='COMMITTED'),0)`));

  check('pools within allocation and non-negative', await query(
    'SELECT id FROM pools WHERE held < 0 OR committed < 0 OR held + committed > allocation'));

  check('every captured payment is a confirmed booking or has a refund', await query(`
    SELECT p.provider_payment_id, b.reference, b.status FROM payments p JOIN bookings b ON b.id=p.booking_id
    WHERE p.state='CAPTURED' AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id=p.id)
      AND (b.status <> 'CONFIRMED' OR p.id <> (SELECT p2.id FROM payments p2 WHERE p2.booking_id=b.id ORDER BY p2.created_at LIMIT 1))`));

  // Cart checkouts: the settling (first) payment must equal confirmed lines + refunds;
  // any later payment on the same checkout must be refunded in full.
  check('every captured cart payment is covered by confirmed lines plus refunds', await query(`
    WITH pay AS (
      SELECT p.id, p.checkout_id, p.amount, p.provider_payment_id,
        row_number() OVER (PARTITION BY p.checkout_id ORDER BY p.created_at) AS n,
        COALESCE((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id=p.id AND r.state<>'FAILED'),0) AS refunded
      FROM payments p WHERE p.checkout_id IS NOT NULL AND p.state='CAPTURED')
    SELECT pay.provider_payment_id, pay.amount, pay.refunded,
      (SELECT COALESCE(sum(b.total),0) FROM bookings b WHERE b.checkout_id=pay.checkout_id AND b.status='CONFIRMED') AS confirmed
    FROM pay
    WHERE (pay.n = 1 AND pay.amount <> pay.refunded + (SELECT COALESCE(sum(b.total),0) FROM bookings b WHERE b.checkout_id=pay.checkout_id AND b.status='CONFIRMED'))
       OR (pay.n > 1 AND pay.refunded < pay.amount)`));

  check('checkout totals equal the sum of their bookings', await query(`
    SELECT co.reference, co.total, (SELECT sum(total) FROM bookings WHERE checkout_id=co.id) AS lines
    FROM checkouts co WHERE co.total <> (SELECT COALESCE(sum(total),0) FROM bookings WHERE checkout_id=co.id)`));

  check('confirmed bookings have exactly quantity tickets with one active credential each', await query(`
    SELECT b.reference, b.quantity, count(DISTINCT t.id)::int tickets, count(c.id)::int creds
    FROM bookings b LEFT JOIN tickets t ON t.booking_id=b.id LEFT JOIN credentials c ON c.ticket_id=t.id AND c.status='ACTIVE'
    WHERE b.status='CONFIRMED' GROUP BY b.id HAVING count(DISTINCT t.id) <> b.quantity OR count(c.id) <> b.quantity`));

  check('no admissible credential on a non-confirmed booking or cancelled show', await query(`
    SELECT b.reference, b.status, s.status show_status FROM credentials c
    JOIN tickets t ON t.id=c.ticket_id JOIN bookings b ON b.id=t.booking_id
    JOIN entitlements e ON e.ticket_id=t.id AND e.status='ACTIVE' JOIN shows s ON s.id=e.show_id
    WHERE c.status='ACTIVE' AND (b.status <> 'CONFIRMED' OR s.status='CANCELLED')`));

  check('refunds never exceed the payment', await query(`
    SELECT p.provider_payment_id FROM payments p JOIN refunds r ON r.payment_id=p.id AND r.state IN ('REQUESTED','PROCESSING','SUCCEEDED')
    GROUP BY p.id HAVING SUM(r.amount) > p.amount`));

  check('one admission per ticket per show', await query(
    'SELECT ticket_id, show_id FROM admissions GROUP BY ticket_id, show_id HAVING count(*) > 1'));

  check('no stuck RUNNING jobs (>15 min)', await query(
    "SELECT kind, key FROM jobs WHERE state='RUNNING' AND locked_at < now() - interval '15 minutes'"));

  const failedJobs = await query("SELECT kind, key, last_error FROM jobs WHERE state='FAILED' ORDER BY run_at DESC LIMIT 20");
  checks.push({ name: 'permanently failed jobs (review)', ok: failedJobs.length === 0, detail: failedJobs.length ? JSON.stringify(failedJobs.slice(0, 5)) : 'none' });
  const cases = await query("SELECT kind, key FROM reconciliation_cases WHERE state='OPEN' ORDER BY created_at DESC LIMIT 20");
  checks.push({ name: 'open reconciliation cases (review)', ok: cases.length === 0, detail: cases.length ? JSON.stringify(cases.slice(0, 5)) : 'none' });

  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    const orders = await query<{ provider_order_id: string }>(
      'SELECT provider_order_id FROM payment_attempts WHERE provider_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 200');
    const missing: { order: string; payment: string }[] = [];
    for (const { provider_order_id } of orders) {
      for (const p of await razorpayListOrderPayments(provider_order_id)) {
        if (p.status !== 'captured') continue;
        const known = await query('SELECT 1 FROM payments WHERE provider_payment_id=$1', [p.id]);
        if (!known.length) missing.push({ order: provider_order_id, payment: p.id });
      }
    }
    check(`Razorpay captured payments all recorded (${orders.length} recent orders)`, missing, 'captured at Razorpay but not in DB');
  } else {
    checks.push({ name: 'Razorpay cross-check', ok: false, detail: 'skipped: RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set' });
  }

  const ref = process.argv[2];
  if (ref) {
    const trail = await query(`
      SELECT b.reference, b.status, b.total, b.expires_at,
        (SELECT json_agg(json_build_object('order',a.provider_order_id,'state',a.state,'checks',a.reconcile_checks)) FROM payment_attempts a WHERE a.booking_id=b.id) attempts,
        (SELECT json_agg(json_build_object('payment',p.provider_payment_id,'amount',p.amount,'state',p.state)) FROM payments p WHERE p.booking_id=b.id) payments,
        (SELECT json_agg(json_build_object('refund',r.provider_refund_id,'amount',r.amount,'state',r.state,'reason',r.reason)) FROM refunds r WHERE r.booking_id=b.id) refunds,
        (SELECT json_agg(json_build_object('ticket',t.reference,'status',t.status)) FROM tickets t WHERE t.booking_id=b.id) tickets,
        (SELECT json_agg(json_build_object('kind',j.kind,'state',j.state,'attempts',j.attempts)) FROM jobs j WHERE j.payload->>'bookingId'=b.id::text) jobs
      FROM bookings b WHERE b.reference=$1`, [ref]);
    console.log(JSON.stringify(trail[0] ?? { error: 'booking not found' }, null, 2));
  }
} finally {
  await query('ROLLBACK').catch(() => undefined);
  await pool.end().catch(() => undefined);
}

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
process.exitCode = checks.some((c) => !c.ok && !c.name.includes('(review)') && !c.name.startsWith('Razorpay cross-check')) ? 1 : 0;
