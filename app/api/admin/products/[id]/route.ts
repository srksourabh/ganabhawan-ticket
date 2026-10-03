import { authenticated } from '@/lib/auth';
import { updateProduct } from '@/lib/catalogue';
import { jsonOk, jsonError, readJson } from '@/lib/http';

const STAFF_ROLES = ['owner', 'inventory'] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    const { id } = await params;
    const body = await readJson<{ price?: number; enabled?: boolean; version?: number; name?: string; nameBn?: string }>(request);
    const result = await updateProduct(user, id, {
      price: Number(body.price ?? 0),
      enabled: body.enabled,
      version: Number(body.version ?? 0),
      name: body.name,
      nameBn: body.nameBn,
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
