import { linkAttempt } from '@/lib/attempts';
import { authenticated } from '@/lib/auth';
import { reserve } from '@/lib/commerce';
import { jsonOk, jsonError, readJson } from '@/lib/http';
import { AppError } from '@/lib/errors';

export async function POST(request: Request): Promise<Response> {
  let attemptId = '';
  let userContact = '';
  let userId = '';
  try {
    const user = await authenticated();
    userContact = user.contact;
    userId = user.id;
    const idempotencyKey = request.headers.get('Idempotency-Key') ?? '';
    if (!idempotencyKey) throw new AppError(400, 'Idempotency-Key header is required.');

    const body = await readJson<{ productId?: string; quantity?: number; version?: number; attemptId?: string }>(request);
    attemptId = body.attemptId ?? '';
    const result = await reserve(
      user,
      {
        productId: body.productId ?? '',
        quantity: body.quantity ?? 0,
        version: body.version ?? 0,
      },
      idempotencyKey,
    );
    if (attemptId) await linkAttempt(attemptId, user.id, user.contact, result.id as string, 'HELD');
    return jsonOk(result, 201);
  } catch (error) {
    if (attemptId && userId) await linkAttempt(attemptId, userId, userContact, null, 'FAILED').catch(() => undefined);
    return jsonError(error);
  }
}
