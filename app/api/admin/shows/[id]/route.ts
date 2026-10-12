import { authenticated } from '@/lib/auth';
import { deleteShow, updateShow } from '@/lib/catalogue';
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

/** Permanently deletes a programme with no history (catalogue.ts deleteShow); 409 with the reason otherwise. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    const { id } = await params;
    return jsonOk(await deleteShow(user, id));
  } catch (error) {
    return jsonError(error);
  }
}
