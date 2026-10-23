import { assertBuyerScope, authenticatedBuyer } from '@/lib/auth';
import { createPaymentOrder } from '@/lib/payments';
import { createCheckoutPaymentOrder } from '@/lib/checkout';
import { jsonOk, jsonError, readJson } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticatedBuyer();
    const body = await readJson<{ bookingId?: string; checkoutId?: string }>(request);
    await assertBuyerScope(user, body.checkoutId ?? body.bookingId ?? '');
    // A cart checkout gets ONE order for its server-computed total.
    const result = body.checkoutId
      ? await createCheckoutPaymentOrder(user, body.checkoutId)
      : await createPaymentOrder(user, body.bookingId ?? '');
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
