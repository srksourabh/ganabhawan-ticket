import { query } from './db';
import { expireHolds } from './commerce';
import { deliverBooking } from './tickets';
import { usingDevelopmentPayments } from './env';
import { reconcileOpenRazorpayPayments } from './payments';
import { razorpayListPaymentRefunds, razorpayRefundPayment, type RazorpayRefundEntity } from './razorpay';
import { sendMessage } from './auth';

export const STALE_JOB_MINUTES = 15;

export const PRUNE_SQL = [
  "DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'",
  "DELETE FROM idempotency WHERE created_at < now() - interval '2 days'",
  "DELETE FROM scan_requests WHERE created_at < now() - interval '7 days'",
];

const MAX_ATTEMPTS = 5;

function backoffMinutes(attempts: number): number {
  // Exponential backoff: 1, 2, 4, 8, 16 minutes
  return Math.pow(2, attempts);
}

async function rememberRefund(refundId: string, provider: RazorpayRefundEntity) {
  const failed = provider.status === 'failed';
  const done = provider.status === 'processed';
  await query(
    `UPDATE refunds SET provider_refund_id=$1, state=CASE WHEN $2 THEN 'FAILED' WHEN $3 THEN 'SUCCEEDED' ELSE 'PROCESSING' END WHERE id=$4`,
    [provider.id, failed, done, refundId],
  );
  if (!done) throw new Error(failed ? 'Refund failed at the payment provider.' : 'Refund is still processing.');
}

export async function processJobs(limit = 20): Promise<number> {
  try {
    await query(
      `UPDATE jobs SET state='PENDING', locked_at=NULL
       WHERE state='RUNNING' AND locked_at IS NOT NULL AND locked_at < now() - ($1 * interval '1 minute')`,
      [STALE_JOB_MINUTES],
    );
  } catch (err) {
    console.error('[jobs] reclaim error', err);
  }

  try {
    for (const sql of PRUNE_SQL) await query(sql);
  } catch (err) {
    console.error('[jobs] prune error', err);
  }

  try {
    await expireHolds();
  } catch (err) {
    console.error('[jobs] expireHolds error', err);
  }

  try {
    await reconcileOpenRazorpayPayments();
  } catch (err) {
    console.error('[jobs] reconcile payments error', err);
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

  let processed = 0;

  for (const job of jobs) {
    try {
      await handleJob(job.kind, job.payload);
      await query("UPDATE jobs SET state='DONE', last_error=NULL WHERE id=$1", [job.id]);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[jobs] ${job.kind}/${job.key} attempt ${job.attempts} failed:`, msg);

      if (job.attempts >= MAX_ATTEMPTS) {
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

  return processed;
}

async function handleJob(kind: string, payload: Record<string, unknown>): Promise<void> {
  switch (kind) {
    case 'EXPIRE': {
      await expireHolds();
      break;
    }

    case 'DELIVERY': {
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

      const refund = (
        await query<{
          id: string;
          amount: number;
          state: string;
          provider_refund_id: string | null;
          provider_payment_id: string;
        }>(
          `SELECT r.id, r.amount, r.state, r.provider_refund_id, p.provider_payment_id
           FROM refunds r JOIN payments p ON p.id = r.payment_id
           WHERE r.id=$1 AND r.state IN ('REQUESTED','PROCESSING')`,
          [refundId],
        )
      )[0];
      if (!refund) return;

      if (usingDevelopmentPayments()) {
        await query("UPDATE refunds SET state='SUCCEEDED' WHERE id=$1", [refundId]);
        break;
      }

      await query("UPDATE refunds SET state='PROCESSING' WHERE id=$1 AND state='REQUESTED'", [refundId]);
      const existing = await razorpayListPaymentRefunds(refund.provider_payment_id);
      const match =
        existing.find((item) => item.id === refund.provider_refund_id) ||
        existing.find((item) => item.notes?.refundId === refund.id);
      if (match) {
        await rememberRefund(refund.id, match);
        break;
      }

      const providerRefund = await razorpayRefundPayment(refund.provider_payment_id, Number(refund.amount), refund.id);
      await rememberRefund(refund.id, providerRefund);
      break;
    }

    default:
      console.warn(`[jobs] Unknown job kind: ${kind}`);
  }
}
