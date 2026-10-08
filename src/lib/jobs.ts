import { query } from './db';
import { expireHolds } from './commerce';
import { reconcileOpenRazorpayPayments } from './payments';
import { executeRefund, pollProcessingRefunds } from './refunds';
import { sendMessage } from './auth';
import { deliverConfirmation, sendSmsConfirmation, type ConfirmationTarget } from './notify';
import { pruneExpiredCartLines, removePurchasedFromCart } from './account-cart';

/** A RUNNING job whose lease (locked_at) is older than this is reclaimed. */
export const STALE_JOB_MINUTES = 15;

/**
 * Housekeeping, as ONE statement (each statement is a Worker subrequest). scan_requests
 * is also the scan log behind the admission metrics, so it is kept for a year, not a week.
 */
export const PRUNE_SQL = [
  `WITH rate AS (DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day' RETURNING 1),
        keys AS (DELETE FROM idempotency WHERE created_at < now() - interval '2 days' RETURNING 1)
   DELETE FROM scan_requests WHERE created_at < now() - interval '365 days'`,
];

export const MAX_ATTEMPTS = 5;

function backoffMinutes(attempts: number): number {
  // Exponential backoff after attempt n: 2, 4, 8, 16 minutes, then FAILED.
  return Math.pow(2, attempts);
}

export interface TickLimits {
  /** Queued jobs claimed and run. */
  jobs: number;
  /** READY payment attempts checked at Razorpay (one provider call each). */
  reconcile: number;
  /** Stalled/processing refunds polled (one provider call each). */
  refunds: number;
}

/**
 * Limits for one tick run inside a Cloudflare Worker (cron trigger or
 * /api/cron/worker). Every Neon HTTP query, transaction socket and provider
 * call is a Worker subrequest, and one invocation may make at most 50 on the
 * Workers Free plan (1000 on Paid). The defaults keep a worst-case tick under
 * that (tests/integration-worker-budget.test.ts); on the Paid plan raise them
 * with WORKER_JOB_BATCH / WORKER_RECONCILE_BATCH / WORKER_REFUND_BATCH.
 * Leftover work is picked up by the next tick.
 */
export function workerTickLimits(): TickLimits {
  const read = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  // A confirmation (receipt, verified contacts, delivery ledger, SMS queue, cart cleanup)
  // costs ~11 subrequests and a settled reconciliation ~6; 2 jobs + 3 reconciliations keep
  // the worst mix under the budget (3 jobs / 5 reconciliations exceeded it in the budget test).
  return { jobs: read('WORKER_JOB_BATCH', 2), reconcile: read('WORKER_RECONCILE_BATCH', 3), refunds: read('WORKER_REFUND_BATCH', 2) };
}

export interface TickSummary {
  reclaimed: number;
  expired: number;
  reconcile: { checked: number; settled: number; failed: number };
  refundsPolled: number;
  /** Unpaid account-cart lines removed because every performance they cover has ended or been cancelled. */
  cartLinesExpired: number;
  processed: number;
  failed: number;
  /** Steps that threw; the remaining steps still ran. */
  errors: string[];
  /** Steps that threw; the remaining steps still ran. */
  errors: string[];
}

/**
 * One worker tick. Every step is idempotent and isolated: a failure in one
 * is logged and the rest still run. Financial side effects (refunds) are
 * serialised per refund and deduplicated at the provider, so a reclaimed or
 * concurrent duplicate run cannot pay twice.
 */
export async function processJobs(limits: number | TickLimits = 20): Promise<TickSummary> {
  const { jobs: limit, reconcile: reconcileLimit, refunds: refundLimit } =
    typeof limits === 'number' ? { jobs: limits, reconcile: 20, refunds: 20 } : limits;
  const summary: TickSummary = { reclaimed: 0, expired: 0, reconcile: { checked: 0, settled: 0, failed: 0 }, refundsPolled: 0, cartLinesExpired: 0, processed: 0, failed: 0, errors: [] };
  try {
    const reclaimed = await query(
      `UPDATE jobs SET state='PENDING', locked_at=NULL
       WHERE state='RUNNING' AND locked_at IS NOT NULL AND locked_at < now() - ($1 * interval '1 minute')
       RETURNING id, kind, key`,
      [STALE_JOB_MINUTES],
    );
    summary.reclaimed = reclaimed.length;
    if (reclaimed.length) console.warn('[alert] reclaimed stale jobs', reclaimed.map((j) => `${j.kind}/${j.key}`).join(', '));
  } catch (err) {
    summary.errors.push('reclaim');
    summary.errors.push('reclaim');
    console.error('[jobs] reclaim error', err);
  }

  try {
    for (const sql of PRUNE_SQL) await query(sql);
  } catch (err) {
    summary.errors.push('prune');
    summary.errors.push('prune');
    console.error('[jobs] prune error', err);
  }

  try {
    summary.expired = await expireHolds();
  } catch (err) {
    summary.errors.push('expire');
    summary.errors.push('expire');
    console.error('[jobs] expireHolds error', err);
  }

  try {
    summary.reconcile = await reconcileOpenRazorpayPayments(reconcileLimit);
    summary.reconcile = await reconcileOpenRazorpayPayments(reconcileLimit);
  } catch (err) {
    summary.errors.push('reconcile');
    summary.errors.push('reconcile');
    console.error('[jobs] reconcile payments error', err);
  }

  try {
    summary.refundsPolled = await pollProcessingRefunds(refundLimit);
    summary.refundsPolled = await pollProcessingRefunds(refundLimit);
  } catch (err) {
    summary.errors.push('refunds');
    summary.errors.push('refunds');
    console.error('[jobs] refund poll error', err);
  }

  try {
    summary.cartLinesExpired = await pruneExpiredCartLines();
  } catch (err) {
    summary.errors.push('cart');
    console.error('[jobs] cart cleanup error', err);
  }

  // Claim pending/runnable jobs. A failed claim is reported like any other step.
  let jobs: { id: string; kind: string; key: string; payload: Record<string, unknown>; attempts: number; state: string }[] = [];
  try {
    jobs = await query(
      `UPDATE jobs SET state='RUNNING', locked_at=now(), attempts=attempts+1
       WHERE id IN (
         SELECT id FROM jobs
         WHERE state='PENDING' AND run_at<=now()
         ORDER BY run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
  } catch (err) {
    summary.errors.push('claim');
    console.error('[jobs] claim error', err);
  }

  for (const job of jobs) {
    try {
      await handleJob(job.kind, job.key, job.payload);
      // locked_at is kept as the completion time (ops "last done"); reclaim only looks at RUNNING.
      await query("UPDATE jobs SET state='DONE', last_error=NULL WHERE id=$1", [job.id]);
      summary.processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[jobs] ${job.kind}/${job.key} attempt ${job.attempts} failed:`, msg);

      if (job.attempts >= MAX_ATTEMPTS) {
        summary.failed++;
        console.error(`[alert] job permanently FAILED ${job.kind}/${job.key}: ${msg}`);
        await query(
          "UPDATE jobs SET state='FAILED', last_error=$1, locked_at=NULL WHERE id=$2",
          [msg, job.id],
        );
      } else {
        const delay = backoffMinutes(job.attempts);
        await query(
          "UPDATE jobs SET state='PENDING', last_error=$1, locked_at=NULL, run_at=now()+$2*interval '1 minute' WHERE id=$3",
          [msg, delay, job.id],
        );
      }
    }
  }

  return summary;
}

function confirmationTarget(payload: Record<string, unknown>, kind: string): ConfirmationTarget {
  const checkoutId = payload['checkoutId'] as string | undefined;
  if (checkoutId) return { checkoutId };
  const bookingId = payload['bookingId'] as string | undefined;
  if (!bookingId) throw new Error(`${kind} job missing bookingId`);
  return { bookingId };
}

async function handleJob(kind: string, key: string, payload: Record<string, unknown>): Promise<void> {
  switch (kind) {
    case 'EXPIRE': {
      await expireHolds();
      break;
    }

    case 'DELIVERY': {
      // Post-payment confirmation: a cart checkout gets ONE consolidated message listing
      // every line; email and SMS per the contacts the customer gave (notify.ts).
      const target = confirmationTarget(payload, 'DELIVERY');
      // A paid checkout's lines leave the account cart even if the browser never came back.
      if ('checkoutId' in target) await removePurchasedFromCart(target.checkoutId);
      await deliverConfirmation(target, key);
      break;
    }

    case 'NOTIFY': {
      if (payload['channel'] !== 'sms') throw new Error('NOTIFY job with unknown channel');
      await sendSmsConfirmation(confirmationTarget(payload, 'NOTIFY'), key);
      break;
    }

    case 'NOTICE': {
      const bookingId = payload['bookingId'] as string | undefined;
      const message = payload['message'] as string | undefined;
      if (!bookingId || !message) throw new Error('NOTICE job missing bookingId or message');
      const row = (
        await query<{ contact: string; reference: string }>(
          'SELECT u.contact, b.reference FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.id=$1',
          [bookingId],
        )
      )[0];
      if (!row) return;
      await sendMessage(row.contact, `Booking update ${row.reference}`, message);
      break;
    }

    case 'REFUND': {
      const refundId = payload['refundId'] as string | undefined;
      if (!refundId) throw new Error('REFUND job missing refundId');
      // Done once the provider holds the refund; PROCESSING is then polled
      // by pollProcessingRefunds and the refund.* webhook, not by this job.
      await executeRefund(refundId);
      break;
    }

    default:
      console.warn(`[jobs] Unknown job kind: ${kind}`);
  }
}
