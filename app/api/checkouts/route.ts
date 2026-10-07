import { authenticated } from '@/lib/auth';
import { createCheckout } from '@/lib/checkout';
import { linkAttempt } from '@/lib/attempts';
import { jsonOk, jsonError, readJson } from '@/lib/http';
import { AppError } from '@/lib/errors';

/**
 * Creates (or, for an identical cart, reuses) ONE checkout holding every cart
 * line. Prices, totals and availability come from the server; the body only
 * names products, quantities and the price version the customer saw.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated();
    const key = request.headers.get('Idempotency-Key') ?? '';
    if (!key) throw new AppError(400, 'Idempotency-Key header is required.');
    const body = await readJson<{ lines?: { productId?: string; quantity?: number; version?: number; attemptId?: string }[] }>(request);
    const checkout = await createCheckout(user, body.lines ?? [], key);
    // The name entered at checkout becomes each booking's holder (owner-only).
    for (const line of body.lines ?? []) {
      const booking = checkout.bookings.find((b) => b.productId === line.productId);
      if (booking && line.attemptId) await linkAttempt(line.attemptId, user.id, user.contact, booking.id, 'HELD').catch(() => undefined);
    }
    return jsonOk(checkout, 201);
  } catch (error) {
    return jsonError(error);
  }
}
