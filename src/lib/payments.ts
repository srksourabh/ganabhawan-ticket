import { createHmac } from 'node:crypto';
import { query, transaction } from './db';
import { AppError, requireValue } from './errors';
import { devMode } from './env';
import { fulfill } from './commerce';
import { audit } from './audit';
import type { User } from './types';

export async function createPaymentOrder(user: User, bookingId: string) {
  const booking = (
    await query(
      "SELECT * FROM bookings WHERE id=$1 AND user_id=$2 AND status='HELD' AND expires_at>now()",
      [bookingId, user.id],
    )
  )[0];
  requireValue(booking, 'Booking not found or no longer held.', 404);

  await transaction(async (c) => {
    await c.query("UPDATE bookings SET status='PAYMENT_PENDING' WHERE id=$1", [bookingId]);

    if (devMode() || process.env.PAYMENT_PROVIDER === 'development') {
      await c.query(
        "INSERT INTO payment_attempts(booking_id,provider_order_id,state) VALUES($1,$2,'READY') ON CONFLICT (provider_order_id) DO NOTHING",
        [bookingId, 'dev-' + bookingId],
      );
      await audit(c, user.id, 'payment.order.dev', bookingId, {});
      return;
    }

    // Razorpay order
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    requireValue(keyId && keySecret, 'Payment provider is not configured.', 503);

    const rzBody = JSON.stringify({
      amount: booking.total,
      currency: booking.currency,
      receipt: booking.reference,
    });
    const rzResp = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: rzBody,
      signal: AbortSignal.timeout(15000),
    });
    requireValue(rzResp.ok, 'Could not create payment order. Please try again.', 502);
    const rzOrder = (await rzResp.json()) as { id: string };

    await c.query(
      "INSERT INTO payment_attempts(booking_id,provider_order_id) VALUES($1,$2)",
      [bookingId, rzOrder.id],
    );
    await audit(c, user.id, 'payment.order.razorpay', bookingId, { orderId: rzOrder.id });
  });

  if (devMode() || process.env.PAYMENT_PROVIDER === 'development') {
    return {
      provider: 'development',
      orderId: 'dev-' + bookingId,
      amount: booking.total,
      currency: booking.currency,
      keyId: 'dev',
      bookingId,
    };
  }

  const attempt = (
    await query('SELECT * FROM payment_attempts WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 1', [bookingId])
  )[0];

  return {
    provider: 'razorpay',
    orderId: attempt.provider_order_id as string,
    amount: booking.total as number,
    currency: booking.currency as string,
    keyId: process.env.RAZORPAY_KEY_ID!,
    bookingId,
  };
}

export async function confirmDevelopmentPayment(user: User, bookingId: string, orderId: string) {
  requireValue(devMode() || process.env.PAYMENT_PROVIDER === 'development', 'Not available in live mode.', 403);

  const booking = (
    await query(
      "SELECT * FROM bookings WHERE id=$1 AND user_id=$2 AND status='PAYMENT_PENDING'",
      [bookingId, user.id],
    )
  )[0];
  requireValue(booking, 'Booking not found or not awaiting payment.', 404);

  const capturedPayment = {
    id: 'dev-pay-' + bookingId,
    orderId,
    amount: booking.total as number,
    currency: booking.currency as string,
    status: 'captured',
  };

  return fulfill(bookingId, capturedPayment);
}

export async function verifyRazorpayCallback(body: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  requireValue(keySecret, 'Razorpay is not configured.', 503);

  const expected = createHmac('sha256', keySecret)
    .update(`${body.razorpay_order_id}|${body.razorpay_payment_id}`)
    .digest('hex');
  requireValue(expected === body.razorpay_signature, 'Payment verification failed.', 400);

  const attempts = await query<{ booking_id: string }>(
    'SELECT * FROM payment_attempts WHERE provider_order_id=$1',
    [body.razorpay_order_id],
  );
  requireValue(attempts[0], 'Unknown payment order.', 404);

  const capturedPayment = {
    id: body.razorpay_payment_id,
    orderId: body.razorpay_order_id,
    amount: 0, // will be overridden by fulfill validation via booking
    currency: 'INR',
    status: 'captured',
  };

  // Fetch booking total to pass correct amount
  const booking = (
    await query('SELECT * FROM bookings WHERE id=$1', [attempts[0].booking_id])
  )[0];
  requireValue(booking, 'Booking not found.', 404);

  return fulfill(attempts[0].booking_id, {
    ...capturedPayment,
    amount: booking.total as number,
    currency: booking.currency as string,
  });
}

export async function ingestRazorpayWebhook(rawBody: string, signature: string) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  requireValue(webhookSecret, 'Webhook secret not configured.', 503);

  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  requireValue(expected === signature, 'Invalid webhook signature.', 400);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'Invalid webhook body.');
  }

  const eventId = payload['id'] as string | undefined;
  requireValue(eventId, 'Missing event id.', 400);

  // Idempotency: ignore duplicate webhook events
  const existing = (
    await query('SELECT id FROM webhook_events WHERE id=$1', [eventId])
  )[0];
  if (existing) return { duplicate: true };

  const digest = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  await query(
    "INSERT INTO webhook_events(id,payload,digest) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
    [eventId, JSON.stringify(payload), digest],
  );

  const event = payload['event'] as string | undefined;
  if (event === 'payment.captured') {
    const paymentEntity = (
      (payload['payload'] as Record<string, unknown>)?.['payment'] as Record<string, unknown>
    )?.['entity'] as Record<string, unknown> | undefined;

    if (paymentEntity) {
      const attempts = await query<{ booking_id: string; provider_order_id: string }>(
        'SELECT * FROM payment_attempts WHERE provider_order_id=$1',
        [paymentEntity['order_id']],
      );

      if (attempts[0]) {
        const booking = (
          await query('SELECT * FROM bookings WHERE id=$1', [attempts[0].booking_id])
        )[0];

        if (booking) {
          try {
            await fulfill(attempts[0].booking_id, {
              id: paymentEntity['id'] as string,
              orderId: attempts[0].provider_order_id,
              amount: booking.total as number,
              currency: booking.currency as string,
              status: 'captured',
            });
          } catch (err) {
            console.error('[webhook] fulfill error', err);
          }
        }
      }
    }
  }

  await query("UPDATE webhook_events SET processed_at=now() WHERE id=$1", [eventId]);
  return { processed: true };
}
