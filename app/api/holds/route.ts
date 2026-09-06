import { authenticated } from '@/lib/auth';
import { reserve } from '@/lib/commerce';
import { jsonOk, jsonError, readJson } from '@/lib/http';
import { AppError } from '@/lib/errors';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated();
    const idempotencyKey = request.headers.get('Idempotency-Key') ?? '';
    if (!idempotencyKey) throw new AppError(400, 'Idempotency-Key header is required.');

    const body = await readJson<{ productId?: string; quantity?: number; version?: number }>(request);
    const result = await reserve(
      user,
      {
        productId: body.productId ?? '',
        quantity: body.quantity ?? 0,
        version: body.version ?? 0,
      },
      idempotencyKey,
    );
    return jsonOk(result, 201);
  } catch (error) {
    return jsonError(error);
  }
}
