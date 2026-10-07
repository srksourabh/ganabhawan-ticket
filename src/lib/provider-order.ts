import { one, query, withSerialLock } from './db';
import { AppError, requireValue } from './errors';
import { razorpayCreateOrder, razorpayFindOrderByReceipt } from './razorpay';

type AttemptRow = { id: string; state: string; provider_order_id: string | null };

/**
 * Ensures exactly one authoritative Razorpay order for a payment attempt
 * (single booking or cart checkout). Serialised per payable entity, so
 * concurrent callers (double-click, two tabs, retries) all converge on one
 * order:
 *  - re-reads the attempt inside the lock and reuses a READY order;
 *  - adopts an existing provider order with the same receipt and amount (a
 *    previous call that timed out after Razorpay created it);
 *  - otherwise creates one, then stores it with a conditional UPDATE that never
 *    overwrites a different stored order (a loser is recorded as an orphan case
 *    and the stored winner is returned).
 * On failure the attempt becomes UNCERTAIN (timeout) or FAILED.
 */
export async function ensureProviderOrder(opts: {
  attemptId: string;
  lockKey: string;
  receipt: string;
  amount: number;
  currency: string;
  notes: Record<string, string>;
  actorId: string;
  auditEntity: string;
}): Promise<string> {
  try {
    return await withSerialLock(opts.lockKey, async (client) => {
      const current = await one<AttemptRow>(client, 'SELECT * FROM payment_attempts WHERE id=$1', [opts.attemptId]);
      if (current?.state === 'READY' && current.provider_order_id) return current.provider_order_id;

      const existing = await razorpayFindOrderByReceipt(opts.receipt);
      const adoptable = existing && Number(existing.amount) === opts.amount && existing.currency === opts.currency ? existing : null;
      const rzOrder =
        adoptable ??
        (await razorpayCreateOrder({ amount: opts.amount, currency: opts.currency, receipt: opts.receipt, notes: opts.notes }));

      const updated = await client.query<{ provider_order_id: string }>(
        `UPDATE payment_attempts SET provider_order_id=$1, state='READY'
         WHERE id=$2 AND (provider_order_id IS NULL OR provider_order_id=$1)
         RETURNING provider_order_id`,
        [rzOrder.id, opts.attemptId],
      );
      let orderId = rzOrder.id;
      if (!updated.rows[0]) {
        const winner = await one<AttemptRow>(client, 'SELECT * FROM payment_attempts WHERE id=$1', [opts.attemptId]);
        await client.query(
          'INSERT INTO reconciliation_cases(key,kind,detail) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING',
          ['orphan-order:' + rzOrder.id, 'PAYMENT', JSON.stringify({ entity: opts.auditEntity, kept: winner?.provider_order_id ?? null, orphan: rzOrder.id })],
        );
        requireValue(winner?.provider_order_id, 'Unknown payment order.', 404);
        orderId = winner!.provider_order_id!;
      }

      try {
        await client.query('INSERT INTO audit_events(actor_id,action,entity,detail) VALUES($1,$2,$3,$4)', [
          opts.actorId,
          'payment.order.razorpay',
          opts.auditEntity,
          JSON.stringify({ orderId }),
        ]);
      } catch (error) {
        console.error('[payments] audit order', error);
      }
      return orderId;
    });
  } catch (error) {
    const uncertain = error instanceof AppError && error.code === 'PROVIDER_TIMEOUT';
    await query("UPDATE payment_attempts SET state=$1 WHERE id=$2 AND state='CREATING'", [uncertain ? 'UNCERTAIN' : 'FAILED', opts.attemptId]);
    throw error;
  }
}
