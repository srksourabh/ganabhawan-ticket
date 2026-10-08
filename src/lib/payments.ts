import { query, transaction, one } from './db';
import { ensureProviderOrder } from './provider-order';
import { createCheckoutPaymentOrder, fulfillCheckout, confirmDevelopmentCheckout, findOwnedCheckout } from './checkout';
import { AppError, requireValue } from './errors';
import { assertLiveConfiguration, developmentAdaptersAllowed, usingDevelopmentPayments } from './env';
import { applyRefundWebhook } from './refunds';
import { expireIn, fulfill, type CapturedPayment } from './commerce';
import { audit } from './audit';
import type { User } from './types';
import { assertCanPurchase } from './account-contacts';
import {
  assertCheckoutSignature,
  assertWebhookSignature,
  ensureCapturedPayment,
  razorpayFetchPayment,
  razorpayKeyId,
  razorpayListOrderPayments,
  razorpayWebhookDigest,
  type RazorpayPaymentEntity,
} from './razorpay';

type BookingRow = {
  id: string;
  user_id: string;
  status: string;
  total: number | string;
  currency: string;
  reference: string;
  expires_at: string;
};

type AttemptRow = {
  id: string;
  booking_id: string;
  provider_order_id: string | null;
  state: string;
};

function paise(value: number | string) {
  return Math.round(Number(value));
}

function capturedFromEntity(payment: RazorpayPaymentEntity): CapturedPayment {
  return {
    id: payment.id,
    orderId: payment.order_id,
    amount: paise(payment.amount),
    currency: payment.currency,
    status: payment.status,
  };
}

function orderResponse(booking: BookingRow, orderId: string, provider: 'development' | 'razorpay') {
  return {
    provider,
    orderId,
    amount: paise(booking.total),
    currency: booking.currency,
    keyId: provider === 'razorpay' ? razorpayKeyId() : 'dev',
    bookingId: booking.id,
  };
}

/**
 * Fair reconciliation. Every READY attempt carries next_reconcile_at; a batch
 * is claimed oldest-due-first with SKIP LOCKED and immediately pushed back, so
 * no set of rows can monopolise the batch. Live checkouts are re-checked every
 * minute; abandoned ones back off exponentially (2 min … 6 h) and retire after
 * RECONCILE_RETIRE_DAYS. A retired order is still settled by the webhook.
 */
export const RECONCILE_LIVE_RECHECK_MINUTES = 1;
export const RECONCILE_MAX_BACKOFF_MINUTES = 360;
export const RECONCILE_RETIRE_DAYS = 7;

/**
 * Live checkouts: every minute. After expiry the gap grows with the time since
 * the hold expired (≈ a quarter of it, 2 min … 6 h), so a capture shortly after
 * expiry is found within minutes while week-old abandoned orders cost little.
 */
export function nextReconcileDelayMinutes(minutesSinceExpiry: number, live: boolean) {
  if (live) return RECONCILE_LIVE_RECHECK_MINUTES;
  return Math.min(Math.max(2, Math.ceil(Math.max(0, minutesSinceExpiry) / 4)), RECONCILE_MAX_BACKOFF_MINUTES);
}

const CLAIM_RECONCILE_SQL = `UPDATE payment_attempts a
   SET next_reconcile_at = now() + interval '5 minutes', reconcile_checks = a.reconcile_checks + 1, last_reconciled_at = now()
   WHERE a.id IN (
     SELECT a2.id FROM payment_attempts a2
     WHERE a2.state = 'READY' AND a2.provider_order_id IS NOT NULL
       AND a2.provider_order_id NOT LIKE 'dev-%' -- development-adapter orders never existed at Razorpay
       AND a2.next_reconcile_at IS NOT NULL AND a2.next_reconcile_at <= now()
       -- single-booking order, or a cart checkout order (bookings share checkout_id)
       AND EXISTS (SELECT 1 FROM bookings b
         WHERE (b.id = a2.booking_id OR (a2.checkout_id IS NOT NULL AND b.checkout_id = a2.checkout_id))
           AND b.status IN ('HELD','PAYMENT_PENDING','EXPIRED','CANCELLED'))
     ORDER BY a2.next_reconcile_at, a2.id
     LIMIT $1
     FOR UPDATE OF a2 SKIP LOCKED)
   RETURNING a.id, a.provider_order_id, a.reconcile_checks, a.created_at,
     (SELECT CASE WHEN bool_and(b.status IN ('HELD','PAYMENT_PENDING')) THEN min(b.expires_at) END FROM bookings b
       WHERE b.id = a.booking_id OR (a.checkout_id IS NOT NULL AND b.checkout_id = a.checkout_id)) AS live_until,
     (SELECT max(b.expires_at) FROM bookings b
       WHERE b.id = a.booking_id OR (a.checkout_id IS NOT NULL AND b.checkout_id = a.checkout_id)) AS booking_expires_at`;

async function openPaymentCase(key: string, detail: unknown) {
  await query(
    'INSERT INTO reconciliation_cases(key,kind,detail) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING',
    [key, 'PAYMENT', JSON.stringify(detail)],
  );
}

export async function createPaymentOrder(user: User, bookingId: string) {
  assertLiveConfiguration();
  await assertCanPurchase(user.id); // a verified mobile is required to buy
  requireValue(bookingId, 'Booking not found or no longer held.', 404);
  // A booking created by a cart checkout is paid as part of that checkout (one payment for the cart).
  const parent = (await query<{ checkout_id: string | null }>('SELECT checkout_id FROM bookings WHERE id=$1 AND user_id=$2', [bookingId, user.id]))[0];
  if (parent?.checkout_id) return createCheckoutPaymentOrder(user, parent.checkout_id);

  const prepared = await transaction(async (c) => {
    await expireIn(c, bookingId);
    const booking = (await one(c, 'SELECT * FROM bookings WHERE id=$1 AND user_id=$2 FOR UPDATE', [
      bookingId,
      user.id,
    ])) as BookingRow | null;
    requireValue(booking, 'Booking not found or no longer held.', 404);
    requireValue(
      (booking.status === 'HELD' || booking.status === 'PAYMENT_PENDING') && new Date(booking.expires_at).getTime() > Date.now(),
      'Booking not found or no longer held.',
      404,
    );

    if (booking.status === 'HELD') {
      await c.query("UPDATE bookings SET status='PAYMENT_PENDING' WHERE id=$1", [bookingId]);
    }

    if (usingDevelopmentPayments()) {
      await c.query(
        "INSERT INTO payment_attempts(booking_id,provider_order_id,state) VALUES($1,$2,'READY') ON CONFLICT (provider_order_id) DO NOTHING",
        [bookingId, 'dev-' + bookingId],
      );
      await audit(c, user.id, 'payment.order.dev', bookingId, {});
      return { booking, provider: 'development' as const, orderId: 'dev-' + bookingId };
    }

    const open = (await one(
      c,
      "SELECT * FROM payment_attempts WHERE booking_id=$1 AND state IN ('CREATING','READY','UNCERTAIN') FOR UPDATE",
      [bookingId],
    )) as AttemptRow | null;

    if (open?.state === 'READY' && open.provider_order_id) {
      return { booking, provider: 'razorpay' as const, orderId: open.provider_order_id, reuse: true };
    }

    if (!open) {
      const attempt = (await one(
        c,
        `INSERT INTO payment_attempts(booking_id,state) VALUES($1,'CREATING')
         ON CONFLICT (booking_id) WHERE state IN ('CREATING','READY','UNCERTAIN') DO NOTHING
         RETURNING *`,
        [bookingId],
      )) as AttemptRow | null;
      const row = attempt ?? (await one(
        c,
        "SELECT * FROM payment_attempts WHERE booking_id=$1 AND state IN ('CREATING','READY','UNCERTAIN') FOR UPDATE",
        [bookingId],
      )) as AttemptRow | null;
      requireValue(row, 'Booking not found or no longer held.', 404);
      if (row.state === 'READY' && row.provider_order_id) {
        return { booking, provider: 'razorpay' as const, orderId: row.provider_order_id, reuse: true };
      }
      return { booking, provider: 'razorpay' as const, attempt: row, create: true };
    }

    return { booking, provider: 'razorpay' as const, attempt: open, create: true };
  }, true);

  if (prepared.provider === 'development') {
    return orderResponse(prepared.booking, prepared.orderId, 'development');
  }

  if ('reuse' in prepared && prepared.reuse) {
    return orderResponse(prepared.booking, prepared.orderId, 'razorpay');
  }

  const attempt = prepared.attempt as AttemptRow;
  const orderId = await ensureProviderOrder({
    attemptId: attempt.id,
    lockKey: 'pay-order:' + prepared.booking.id,
    receipt: prepared.booking.reference,
    amount: paise(prepared.booking.total),
    currency: prepared.booking.currency,
    notes: { bookingId: prepared.booking.id, reference: prepared.booking.reference },
    actorId: user.id,
    auditEntity: bookingId,
  });
  return orderResponse(prepared.booking, orderId, 'razorpay');
}

export async function confirmDevelopmentPayment(user: User, bookingId: string, orderId: string) {
  assertLiveConfiguration();
  requireValue(developmentAdaptersAllowed(), 'Development payments are not available on a public host.', 403);
  requireValue(usingDevelopmentPayments(), 'Not available when Razorpay is enabled.', 403);
  // Cart checkouts confirm through their parent (the client sends the checkout id).
  if (await findOwnedCheckout(user.id, bookingId)) return confirmDevelopmentCheckout(user, bookingId, orderId);

  const booking = (
    await query(
      "SELECT * FROM bookings WHERE id=$1 AND user_id=$2 AND status='PAYMENT_PENDING'",
      [bookingId, user.id],
    )
  )[0] as BookingRow | undefined;
  requireValue(booking, 'Booking not found or not awaiting payment.', 404);

  return fulfill(bookingId, {
    id: 'dev-pay-' + bookingId,
    orderId,
    amount: paise(booking.total),
    currency: booking.currency,
    status: 'captured',
  });
}

async function settleRazorpayPayment(payment: RazorpayPaymentEntity) {
  const captured = await ensureCapturedPayment(payment);
  const attempts = await query<{ booking_id: string | null; checkout_id: string | null; provider_order_id: string }>(
    'SELECT * FROM payment_attempts WHERE provider_order_id=$1',
    [captured.order_id],
  );
  if (!attempts[0]) {
    await openPaymentCase('unknown-order:' + captured.id, {
      orderId: captured.order_id,
      paymentId: captured.id,
      reason: 'Captured payment has no stored order.',
    });
    throw new AppError(404, 'Unknown payment order.');
  }
  requireValue(captured.order_id === attempts[0].provider_order_id, 'Payment order mismatch.', 400);
  if (attempts[0].checkout_id) return fulfillCheckout(attempts[0].checkout_id, capturedFromEntity(captured));
  return fulfill(attempts[0].booking_id!, capturedFromEntity(captured));
}

export async function verifyRazorpayCallback(
  body: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  },
  user?: User,
) {
  requireValue(!usingDevelopmentPayments(), 'Razorpay is not the active payment provider.', 409);
  assertCheckoutSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature);

  const payment = await razorpayFetchPayment(body.razorpay_payment_id);
  requireValue(payment.order_id === body.razorpay_order_id, 'Payment verification failed.', 400);

  if (user) {
    const attempt = (
      await query<{ booking_id: string | null; checkout_id: string | null }>(
        'SELECT booking_id, checkout_id FROM payment_attempts WHERE provider_order_id=$1',
        [body.razorpay_order_id],
      )
    )[0];
    requireValue(attempt, 'Unknown payment order.', 404);
    const owner = (
      await query<{ user_id: string }>(
        attempt.checkout_id ? 'SELECT user_id FROM checkouts WHERE id=$1' : 'SELECT user_id FROM bookings WHERE id=$1',
        [attempt.checkout_id ?? attempt.booking_id],
      )
    )[0];
    requireValue(owner && owner.user_id === user.id, 'Booking not found or not awaiting payment.', 404);
  }

  return settleRazorpayPayment(payment);
}

export async function syncRazorpayPayment(user: User, bookingId: string) {
  requireValue(!usingDevelopmentPayments(), 'Razorpay is not the active payment provider.', 409);
  requireValue(bookingId, 'Booking not found or not awaiting payment.', 404);

  const checkout = await findOwnedCheckout(user.id, bookingId);
  if (checkout) {
    const order = (await query<AttemptRow>(
      'SELECT * FROM payment_attempts WHERE checkout_id=$1 AND provider_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      [checkout.id],
    ))[0];
    requireValue(order?.provider_order_id, 'No payment order to reconcile.', 404);
    return settleRazorpayOrder(order.provider_order_id!);
  }
  const booking = (
    await query("SELECT * FROM bookings WHERE id=$1 AND user_id=$2 AND status IN ('PAYMENT_PENDING','CONFIRMED','EXPIRED','REFUND_REQUIRED')", [
      bookingId,
      user.id,
    ])
  )[0] as BookingRow | undefined;
  requireValue(booking, 'Booking not found or not awaiting payment.', 404);

  const attempt = (
    await query<AttemptRow>(
      "SELECT * FROM payment_attempts WHERE booking_id=$1 AND provider_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [bookingId],
    )
  )[0];
  requireValue(attempt?.provider_order_id, 'No payment order to reconcile.', 404);

  return settleRazorpayOrder(attempt.provider_order_id);
}

/** Settles every captured/authorized payment on an order (a second payment becomes a refund). */
export async function settleRazorpayOrder(orderId: string) {
  const payments = await razorpayListOrderPayments(orderId);
  const paid = payments.filter((item) => item.status === 'captured' || item.status === 'authorized');
  requireValue(paid.length > 0, 'Payment is not yet captured. Complete checkout and try again.', 409);
  let result: Awaited<ReturnType<typeof settleRazorpayPayment>> | undefined;
  for (const payment of paid) {
    const settled = await settleRazorpayPayment(payment);
    result ??= settled;
  }
  return result!;
}

export async function reconcileOpenRazorpayPayments(limit = 20): Promise<{ checked: number; settled: number; failed: number }> {
  if (usingDevelopmentPayments()) return { checked: 0, settled: 0, failed: 0 };

  const rows = await query<{
    id: string;
    provider_order_id: string;
    reconcile_checks: number;
    created_at: string;
    live_until: string | null;
    booking_expires_at: string;
  }>(CLAIM_RECONCILE_SQL, [limit]);

  let settled = 0;
  let failed = 0;
  for (const row of rows) {
    const live = row.live_until !== null && new Date(row.live_until).getTime() > Date.now();
    try {
      await settleRazorpayOrder(row.provider_order_id);
      settled += 1;
      await query('UPDATE payment_attempts SET next_reconcile_at=NULL WHERE id=$1', [row.id]);
      continue;
    } catch (error) {
      if (!(error instanceof AppError && error.status === 409)) {
        failed += 1;
        console.error('[payments] reconcile', row.provider_order_id, error instanceof Error ? error.message : error);
      }
    }
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (!live && ageMs > RECONCILE_RETIRE_DAYS * 86_400_000) {
      await query('UPDATE payment_attempts SET next_reconcile_at=NULL WHERE id=$1', [row.id]);
    } else {
      const minutesSinceExpiry = (Date.now() - new Date(row.booking_expires_at).getTime()) / 60_000;
      await query("UPDATE payment_attempts SET next_reconcile_at=now() + $1 * interval '1 minute' WHERE id=$2", [
        nextReconcileDelayMinutes(minutesSinceExpiry, live),
        row.id,
      ]);
    }
  }
  return { checked: rows.length, settled, failed };
}

function refundEntityFromWebhook(payload: Record<string, unknown>): { id: string; status?: string; notes?: Record<string, string> } | null {
  const inner = payload['payload'] as Record<string, unknown> | undefined;
  const refund = (inner?.['refund'] as Record<string, unknown> | undefined)?.['entity'] as
    | { id?: string; status?: string; notes?: Record<string, string> }
    | undefined;
  if (refund?.id) return { id: refund.id, status: refund.status, notes: refund.notes };
  return null;
}

function paymentEntityFromWebhook(payload: Record<string, unknown>): RazorpayPaymentEntity | null {
  const inner = payload['payload'] as Record<string, unknown> | undefined;
  const payment = (inner?.['payment'] as Record<string, unknown> | undefined)?.['entity'] as
    | RazorpayPaymentEntity
    | undefined;
  if (payment?.id && payment.order_id) return payment;
  return null;
}

export async function ingestRazorpayWebhook(rawBody: string, signature: string) {
  const webhookSecret = assertWebhookSignature(rawBody, signature);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'Invalid webhook body.');
  }

  const digest = razorpayWebhookDigest(rawBody, webhookSecret);
  const paymentEntity = paymentEntityFromWebhook(payload);
  const eventId =
    (typeof payload['id'] === 'string' && payload['id']) ||
    (paymentEntity ? `${payload['event']}:${paymentEntity.id}:${payload['created_at']}` : digest);

  const existing = (await query('SELECT id, processed_at FROM webhook_events WHERE id=$1', [eventId]))[0] as
    | { id: string; processed_at: string | null }
    | undefined;
  if (existing?.processed_at) return { duplicate: true };

  await query("INSERT INTO webhook_events(id,payload,digest) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [
    eventId,
    JSON.stringify(payload),
    digest,
  ]);

  const event = payload['event'] as string | undefined;
  const refundEntity = refundEntityFromWebhook(payload);
  if (refundEntity && (event === 'refund.processed' || event === 'refund.failed')) {
    await applyRefundWebhook(refundEntity, event);
  }
  if (paymentEntity && (event === 'payment.captured' || event === 'payment.authorized' || event === 'order.paid')) {
    try {
      await settleRazorpayPayment(paymentEntity);
    } catch (error) {
      if (error instanceof AppError && error.status >= 400 && error.status < 500) {
        await openPaymentCase('webhook:' + eventId, {
          message: error.message,
          paymentId: paymentEntity.id,
          orderId: paymentEntity.order_id,
        });
        console.error('[webhook] fulfill rejected', error.message);
      } else {
        throw error;
      }
    }
  }

  await query('UPDATE webhook_events SET processed_at=now() WHERE id=$1', [eventId]);
  return { processed: true };
}
