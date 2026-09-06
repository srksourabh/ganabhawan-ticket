import { query, transaction } from './db';
import { expireHolds } from './commerce';
import { deliverBooking } from './tickets';
import { devMode } from './env';

const MAX_ATTEMPTS = 5;

function backoffMinutes(attempts: number): number {
  // Exponential backoff: 1, 2, 4, 8, 16 minutes
  return Math.pow(2, attempts);
}

export async function processJobs(limit = 20): Promise<number> {
  // Always run expireHolds on every tick
  try {
    await expireHolds();
  } catch (err) {
    console.error('[jobs] expireHolds error', err);
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

    case 'REFUND': {
      const refundId = payload['refundId'] as string | undefined;
      if (!refundId) throw new Error('REFUND job missing refundId');

      if (devMode() || process.env.PAYMENT_PROVIDER === 'development') {
        await transaction(async (c) => {
          const refund = (
            await c.query<{ id: string; state: string }>(
              "SELECT * FROM refunds WHERE id=$1 AND state IN ('REQUESTED','PROCESSING')",
              [refundId],
            )
          ).rows[0];
          if (!refund) return;
          await c.query("UPDATE refunds SET state='SUCCEEDED' WHERE id=$1", [refundId]);
        });
      } else {
        // Live mode: leave PENDING for manual reconciliation / Razorpay webhooks
        console.log(`[jobs] REFUND ${refundId}: leaving for live provider`);
      }
      break;
    }

    default:
      console.warn(`[jobs] Unknown job kind: ${kind}`);
  }
}
