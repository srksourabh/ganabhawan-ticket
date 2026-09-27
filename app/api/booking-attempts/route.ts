import { currentUser, rateLimit } from '@/lib/auth';
import { recordBookingAttempt } from '@/lib/attempts';
import { hash } from '@/lib/security';
import { clientIp, jsonError, jsonOk, readJson } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    await rateLimit('attempt-ip:' + hash(clientIp(request)), 40, 3600);
    const user = await currentUser();
    const body = await readJson<{ name?: string; contact?: string; productId?: string; quantity?: number }>(request);
    const row = await recordBookingAttempt({
      name: body.name?.trim() || user?.name,
      contact: body.contact?.trim() || user?.contact,
      productId: body.productId,
      quantity: body.quantity,
      userId: user?.id ?? null,
    });
    return jsonOk(row, 201);
  } catch (error) {
    return jsonError(error);
  }
}
