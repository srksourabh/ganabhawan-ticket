import { assertBuyerScope, authenticatedBuyer } from '@/lib/auth';
import { syncRazorpayPayment } from '@/lib/payments';
import { jsonOk, jsonError, readJson } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticatedBuyer();
    const body = await readJson<{ bookingId?: string }>(request);
    await assertBuyerScope(user, body.bookingId ?? '');
    const result = await syncRazorpayPayment(user, body.bookingId ?? '');
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
