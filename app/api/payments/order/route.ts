import { authenticated } from '@/lib/auth';
import { createPaymentOrder } from '@/lib/payments';
import { jsonOk, jsonError, readJson } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated();
    const body = await readJson<{ bookingId?: string }>(request);
    const result = await createPaymentOrder(user, body.bookingId ?? '');
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
