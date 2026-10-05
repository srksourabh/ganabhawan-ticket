import { one, pool, query, withSessionLock, type Client } from './db';
import { audit } from './audit';
import { usingDevelopmentPayments, developmentAdaptersAllowed } from './env';
import {
  razorpayFetchRefund,
  razorpayListPaymentRefunds,
  razorpayRefundPayment,
  type RazorpayRefundEntity,
} from './razorpay';

/**
 * Refund state machine (provider-confirmed):
 *   REQUESTED ──job──► PROCESSING ──provider "processed"──► SUCCEEDED
 *                          └──────provider "failed"──────► FAILED (+ reconciliation case)
 * SUCCEEDED and FAILED are terminal; a late or duplicate event never moves them.
 * A REFUND_REQUIRED booking becomes REFUNDED once all its refunds SUCCEEDED.
 */
export type RefundState = 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

export function refundStateFromProvider(status: string | undefined): RefundState {
  if (status === 'processed') return 'SUCCEEDED';
  if (status === 'failed') return 'FAILED';
  return 'PROCESSING';
}

type Queryable = Pick<Client, 'query'>;

export async function applyRefundState(db: Queryable, refundId: string, providerRefundId: string | null, next: RefundState) {
  const updated = (await db.query<{ id: string; booking_id: string; state: string }>(
    `UPDATE refunds SET state=$1, provider_refund_id=COALESCE(provider_refund_id,$2), updated_at=now(), last_checked_at=now()
     WHERE id=$3 AND state IN ('REQUESTED','PROCESSING')
     RETURNING id, booking_id, state`,
    [next, providerRefundId, refundId],
  )).rows[0];
  if (!updated) return null; // already terminal, or unknown: never regress

  if (next === 'SUCCEEDED') {
    await db.query(
      `UPDATE bookings SET status='REFUNDED' WHERE id=$1 AND status='REFUND_REQUIRED'
       AND NOT EXISTS (SELECT 1 FROM refunds WHERE booking_id=$1 AND state<>'SUCCEEDED')`,
      [updated.booking_id],
    );
  }
  if (next === 'FAILED') {
    await db.query(
      'INSERT INTO reconciliation_cases(key,kind,detail) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING',
      ['refund-failed:' + refundId, 'REFUND', JSON.stringify({ refundId, bookingId: updated.booking_id, providerRefundId })],
    );
    console.error('[alert] refund failed at provider', refundId);
  }
  if (next !== 'PROCESSING') {
    await db.query('INSERT INTO audit_events(actor_id,action,entity,detail) VALUES(NULL,$1,$2,$3)', [
      'refund.' + next.toLowerCase(),
      refundId,
      JSON.stringify({ providerRefundId }),
    ]);
  }
  return updated;
}

/**
 * The REFUND job. Serialised per refund with a session lock, and before
 * creating anything it looks for a provider refund already carrying our id
 * (notes.refundId), so retries, reclaimed jobs and concurrent workers can
 * never create a second provider refund.
 */
export async function executeRefund(refundId: string) {
  return withSessionLock('refund:' + refundId, async (c) => {
    const refund = await one<{ id: string; amount: number; state: string; provider_refund_id: string | null; provider_payment_id: string }>(
      c,
      `SELECT r.id, r.amount, r.state, r.provider_refund_id, p.provider_payment_id
       FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE r.id=$1`,
      [refundId],
    );
    if (!refund || (refund.state !== 'REQUESTED' && refund.state !== 'PROCESSING')) return refund?.state ?? 'MISSING';

    if (usingDevelopmentPayments()) {
      // Dev payments never took real money; only a local dev runtime may "refund" them.
      if (!developmentAdaptersAllowed()) throw new Error('Development refunds are refused outside local development.');
      await applyRefundState(c, refund.id, null, 'SUCCEEDED');
      return 'SUCCEEDED';
    }

    await c.query("UPDATE refunds SET state='PROCESSING', updated_at=now() WHERE id=$1 AND state='REQUESTED'", [refund.id]);
    const existing = await razorpayListPaymentRefunds(refund.provider_payment_id);
    const match =
      existing.find((item) => refund.provider_refund_id && item.id === refund.provider_refund_id) ||
      existing.find((item) => item.notes?.refundId === refund.id);
    const provider: RazorpayRefundEntity =
      match ?? (await razorpayRefundPayment(refund.provider_payment_id, Number(refund.amount), refund.id));
    const next = refundStateFromProvider(provider.status);
    await applyRefundState(c, refund.id, provider.id, next);
    if (!match) await audit(c, null, 'refund.requested', refund.id, { providerRefundId: provider.id, amount: Number(refund.amount) });
    return next;
  });
}

/** Polls refunds still PROCESSING at the provider, least-recently-checked first. */
export async function pollProcessingRefunds(limit = 20) {
  if (usingDevelopmentPayments()) return 0;
  const rows = await query<{ id: string; provider_refund_id: string }>(
    `UPDATE refunds SET last_checked_at=now() WHERE id IN (
       SELECT id FROM refunds WHERE state='PROCESSING' AND provider_refund_id IS NOT NULL
         AND (last_checked_at IS NULL OR last_checked_at < now() - interval '10 minutes')
       ORDER BY last_checked_at NULLS FIRST, id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, provider_refund_id`,
    [limit],
  );
  let changed = 0;
  for (const row of rows) {
    try {
      const provider = await razorpayFetchRefund(row.provider_refund_id);
      const next = refundStateFromProvider(provider.status);
      if (next !== 'PROCESSING' && (await applyRefundState(pool, row.id, provider.id, next))) changed += 1;
    } catch (error) {
      console.error('[refunds] poll failed', row.id, error instanceof Error ? error.message : error);
    }
  }
  return changed;
}

/** Webhook entry: refund.processed / refund.failed, matched by provider id or our note. */
export async function applyRefundWebhook(entity: { id: string; status?: string; notes?: Record<string, string> }, event: string) {
  const noteId = entity.notes?.refundId ?? '';
  const refund = (await query<{ id: string }>(
    `SELECT id FROM refunds WHERE provider_refund_id=$1 OR ($2<>'' AND id::text=$2) LIMIT 1`,
    [entity.id, noteId],
  ))[0];
  if (!refund) return null;
  const next: RefundState = event === 'refund.failed' || entity.status === 'failed' ? 'FAILED' : 'SUCCEEDED';
  return applyRefundState(pool, refund.id, entity.id, next);
}
