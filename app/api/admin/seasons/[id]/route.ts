import { authenticated } from '@/lib/auth';
import { ADMIN_POLICY } from '@/lib/admin-policy';
import { deleteSeason, updateSeason } from '@/lib/seasons';
import { jsonOk, jsonError, readJson } from '@/lib/http';

/** Edits { name?, nameBn?, price? (paise), enabled?, version } of a season ticket; other fields are refused. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    const { id } = await params;
    return jsonOk(await updateSeason(user, id, await readJson<Record<string, unknown>>(request)));
  } catch (error) {
    return jsonError(error);
  }
}

/** Deletes a season ticket that was never booked; 409 SEASON_HAS_HISTORY with the reason otherwise. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    const { id } = await params;
    return jsonOk(await deleteSeason(user, id));
  } catch (error) {
    return jsonError(error);
  }
}
