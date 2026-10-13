import { authenticated } from '@/lib/auth';
import { ADMIN_POLICY } from '@/lib/admin-policy';
import { createSeason, seasonsOverview } from '@/lib/seasons';
import { jsonOk, jsonError, readJson } from '@/lib/http';

/** Every season ticket (one per zone) with its performances, sales state and delete eligibility (seasons.ts). */
export async function GET(): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    return jsonOk(await seasonsOverview(user));
  } catch (error) {
    return jsonError(error);
  }
}

/** Creates a zone's season ticket: { zone, name, nameBn, price (paise) }. */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    return jsonOk(await createSeason(user, await readJson<Record<string, unknown>>(request)), 201);
  } catch (error) {
    return jsonError(error);
  }
}
