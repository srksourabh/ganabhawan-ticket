import { authenticated } from '@/lib/auth';
import { ADMIN_POLICY } from '@/lib/admin-policy';
import { removeSeasonPerformance } from '@/lib/seasons';
import { jsonOk, jsonError } from '@/lib/http';

/** Removes a performance from a season ticket. Only before anything was bought, never the last one. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; showId: string }> }): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    const { id, showId } = await params;
    return jsonOk(await removeSeasonPerformance(user, id, showId));
  } catch (error) {
    return jsonError(error);
  }
}
