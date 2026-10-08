import { authenticated } from '@/lib/auth';
import { addShowToSeason } from '@/lib/inventory-admin';
import { ADMIN_POLICY } from '@/lib/admin-policy';
import { jsonError, jsonOk, readJson } from '@/lib/http';

/** Explicitly adds one performance to a season ticket: { showId }. Refused once the season has sales. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    const { id } = await params;
    const body = await readJson<{ showId?: string }>(request);
    return jsonOk(await addShowToSeason(user, id, String(body.showId ?? '')));
  } catch (error) {
    return jsonError(error);
  }
}
