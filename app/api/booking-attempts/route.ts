import { currentBuyer, rateLimit } from '@/lib/auth';
import { recordBookingAttempt } from '@/lib/attempts';
import { hash, keyedHash } from '@/lib/security';
import { clientIp, jsonError, jsonOk, readJson } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await currentBuyer();
    const body = await readJson<{ name?: string; contact?: string; email?: string; phone?: string; productId?: string; quantity?: number }>(request);
    // Per buyer, not per network address: many genuine buyers can share one address (venue or office
    // Wi-Fi, mobile carriers). The address keeps a looser ceiling against floods.
    const who = String(user?.id ?? body?.email ?? body?.contact ?? '').trim().toLowerCase();
    await rateLimit('attempt-buyer:' + keyedHash(who), 40, 3600);
    await rateLimit('attempt-ip:' + hash(clientIp(request)), 300, 3600);
    const row = await recordBookingAttempt({
      name: body.name?.trim() || user?.name,
      contact: body.contact?.trim() || user?.contact,
      email: body.email,
      phone: body.phone,
      productId: body.productId,
      quantity: body.quantity,
      userId: user?.id ?? null,
    });
    return jsonOk(row, 201);
  } catch (error) {
    return jsonError(error);
  }
}
