import { authenticated } from '@/lib/auth';
import { ADMIN_POLICY } from '@/lib/admin-policy';
import { addSeasonPerformance } from '@/lib/seasons';
import { jsonOk, jsonError, readJson } from '@/lib/http';

/** Adds a performance to a season ticket: { showId }. Only before anything was bought. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    const { id } = await params;
    const body = await readJson<{ showId?: unknown }>(request);
    return jsonOk(await addSeasonPerformance(user, id, body?.showId));
  } catch (error) {
    return jsonError(error);
  }
}
