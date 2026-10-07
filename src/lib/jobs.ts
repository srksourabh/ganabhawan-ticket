import { query } from './db';
import { expireHolds } from './commerce';
import { deliverBooking } from './tickets';
import { reconcileOpenRazorpayPayments } from './payments';
import { executeRefund, pollProcessingRefunds } from './refunds';
import { sendMessage } from './auth';
import { deliverCheckout } from './checkout';

/** A RUNNING job whose lease (locked_at) is older than this is reclaimed. */
export const STALE_JOB_MINUTES = 15;

export const PRUNE_SQL = [
  "DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'",
  "DELETE FROM idempotency WHERE created_at < now() - interval '2 days'",
  "DELETE FROM scan_requests WHERE created_at < now() - interval '7 days'",
];

export const MAX_ATTEMPTS = 5;

function backoffMinutes(attempts: number): number {
  // Exponential backoff after attempt n: 2, 4, 8, 16 minutes, then FAILED.
  return Math.pow(2, attempts);
}

export interface TickSummary {
  reclaimed: number;
  expired: number;
  reconcile: { checked: number; settled: number; failed: number };
  refundsPolled: number;
  processed: number;
  failed: number;
}

/**
 * One worker tick. Every step is idempotent and isolated: a failure in one
 * is logged and the rest still run. Financial side effects (refunds) are
 * serialised per refund and deduplicated at the provider, so a reclaimed or
 * concurrent duplicate run cannot pay twice.
 */
export async function processJobs(limit = 20): Promise<TickSummary> {
  const summary: TickSummary = { reclaimed: 0, expired: 0, reconcile: { checked: 0, settled: 0, failed: 0 }, refundsPolled: 0, processed: 0, failed: 0 };
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
    console.error('[jobs] reclaim error', err);
  }

  try {
    for (const sql of PRUNE_SQL) await query(sql);
  } catch (err) {
    console.error('[jobs] prune error', err);
  }

  try {
    summary.expired = await expireHolds();
  } catch (err) {
    console.error('[jobs] expireHolds error', err);
  }

  try {
    summary.reconcile = await reconcileOpenRazorpayPayments();
  } catch (err) {
    console.error('[jobs] reconcile payments error', err);
  }

  try {
    summary.refundsPolled = await pollProcessingRefunds();
  } catch (err) {
    console.error('[jobs] refund poll error', err);
  }

  // Claim pending/runnable jobs
  const jobs = await query<{
    id: string;
    kind: string;
    key: string;
    payload: Record<string, unknown>;
    attempts: number;
    state: string;
  }>(
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

  for (const job of jobs) {
    try {
      await handleJob(job.kind, job.payload);
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

async function handleJob(kind: string, payload: Record<string, unknown>): Promise<void> {
  switch (kind) {
    case 'EXPIRE': {
      await expireHolds();
      break;
    }

    case 'DELIVERY': {
      // A cart checkout gets ONE consolidated confirmation listing every line.
      const checkoutId = payload['checkoutId'] as string | undefined;
      if (checkoutId) {
        await deliverCheckout(checkoutId);
        break;
      }
      const bookingId = payload['bookingId'] as string | undefined;
      if (!bookingId) throw new Error('DELIVERY job missing bookingId');
      await deliverBooking(bookingId);
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
