import { authenticated } from '@/lib/auth';
import { updateShow } from '@/lib/catalogue';
import { jsonOk, jsonError, readJson } from '@/lib/http';

const STAFF_ROLES = ['owner', 'inventory'] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    const { id } = await params;
    const body = await readJson<Record<string, unknown>>(request);
    const show = await updateShow(user, id, body);
    return jsonOk(show);
  } catch (error) {
    return jsonError(error);
  }
}
