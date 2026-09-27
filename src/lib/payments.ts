import { query, transaction, one } from './db';
import { AppError, requireValue } from './errors';
import { usingDevelopmentPayments } from './env';
import { expireIn, fulfill, type CapturedPayment } from './commerce';
import { audit } from './audit';
import type { User } from './types';
import {
  assertCheckoutSignature,
  assertWebhookSignature,
  ensureCapturedPayment,
  razorpayCreateOrder,
  razorpayFetchPayment,
  razorpayFindOrderByReceipt,
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

export async function createPaymentOrder(user: User, bookingId: string) {
  requireValue(bookingId, 'Booking not found or no longer held.', 404);

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
        "INSERT INTO payment_attempts(booking_id,state) VALUES($1,'CREATING') RETURNING *",
        [bookingId],
      )) as AttemptRow;
      return { booking, provider: 'razorpay' as const, attempt, create: true };
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
  try {
    const existing = await razorpayFindOrderByReceipt(prepared.booking.reference);
    const rzOrder =
      existing ??
      (await razorpayCreateOrder({
        amount: paise(prepared.booking.total),
        currency: prepared.booking.currency,
        receipt: prepared.booking.reference,
        notes: { bookingId: prepared.booking.id, reference: prepared.booking.reference },
      }));

    await query("UPDATE payment_attempts SET provider_order_id=$1, state='READY' WHERE id=$2", [rzOrder.id, attempt.id]);
    try {
      await query("INSERT INTO audit_events(actor_id,action,entity,detail) VALUES($1,$2,$3,$4)", [
        user.id,
        'payment.order.razorpay',
        bookingId,
        JSON.stringify({ orderId: rzOrder.id }),
      ]);
    } catch (error) {
      console.error('[payments] audit order', error);
    }
    return orderResponse(prepared.booking, rzOrder.id, 'razorpay');
  } catch (error) {
    const uncertain = error instanceof AppError && error.code === 'PROVIDER_TIMEOUT';
    await query("UPDATE payment_attempts SET state=$1 WHERE id=$2 AND state='CREATING'", [
      uncertain ? 'UNCERTAIN' : 'FAILED',
      attempt.id,
    ]);
    throw error;
  }
}

export async function confirmDevelopmentPayment(user: User, bookingId: string, orderId: string) {
  requireValue(usingDevelopmentPayments(), 'Not available when Razorpay is enabled.', 403);

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
  const attempts = await query<{ booking_id: string; provider_order_id: string }>(
    'SELECT * FROM payment_attempts WHERE provider_order_id=$1',
    [captured.order_id],
  );
  requireValue(attempts[0], 'Unknown payment order.', 404);
  requireValue(captured.order_id === attempts[0].provider_order_id, 'Payment order mismatch.', 400);
  return fulfill(attempts[0].booking_id, capturedFromEntity(captured));
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
      await query<{ booking_id: string }>(
        'SELECT booking_id FROM payment_attempts WHERE provider_order_id=$1',
        [body.razorpay_order_id],
      )
    )[0];
    requireValue(attempt, 'Unknown payment order.', 404);
    const booking = (
      await query<{ user_id: string }>('SELECT user_id FROM bookings WHERE id=$1', [attempt.booking_id])
    )[0];
    requireValue(booking && booking.user_id === user.id, 'Booking not found or not awaiting payment.', 404);
  }

  return settleRazorpayPayment(payment);
}

export async function syncRazorpayPayment(user: User, bookingId: string) {
  requireValue(!usingDevelopmentPayments(), 'Razorpay is not the active payment provider.', 409);
  requireValue(bookingId, 'Booking not found or not awaiting payment.', 404);

  const booking = (
    await query("SELECT * FROM bookings WHERE id=$1 AND user_id=$2 AND status IN ('PAYMENT_PENDING','CONFIRMED')", [
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

export async function settleRazorpayOrder(orderId: string) {
  const payments = await razorpayListOrderPayments(orderId);
  const paid = payments.find((item) => item.status === 'captured' || item.status === 'authorized');
  requireValue(paid, 'Payment is not yet captured. Complete checkout and try again.', 409);
  return settleRazorpayPayment(paid);
}

export async function reconcileOpenRazorpayPayments(limit = 20): Promise<number> {
  if (usingDevelopmentPayments()) return 0;

  const rows = await query<{ provider_order_id: string }>(
    `SELECT a.provider_order_id
     FROM payment_attempts a
     JOIN bookings b ON b.id = a.booking_id
     WHERE a.state = 'READY' AND a.provider_order_id IS NOT NULL
       AND b.status = 'PAYMENT_PENDING' AND b.expires_at > now()
     ORDER BY a.created_at
     LIMIT $1`,
    [limit],
  );

  let settled = 0;
  for (const row of rows) {
    try {
      await settleRazorpayOrder(row.provider_order_id);
      settled += 1;
    } catch (error) {
      if (!(error instanceof AppError && error.status === 409)) {
        console.error('[payments] reconcile', row.provider_order_id, error);
      }
    }
  }
  return settled;
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
  if (paymentEntity && (event === 'payment.captured' || event === 'payment.authorized' || event === 'order.paid')) {
    try {
      await settleRazorpayPayment(paymentEntity);
    } catch (error) {
      if (error instanceof AppError && error.status >= 400 && error.status < 500) {
        console.error('[webhook] fulfill rejected', error.message);
      } else {
        throw error;
      }
    }
  }

  await query('UPDATE webhook_events SET processed_at=now() WHERE id=$1', [eventId]);
  return { processed: true };
}
