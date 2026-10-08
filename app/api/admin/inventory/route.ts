import { authenticated } from '@/lib/auth';
import { configureCapacity, configureSeasonForZone, inventoryOverview } from '@/lib/inventory-admin';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { ADMIN_POLICY } from '@/lib/admin-policy';

/** Owner and inventory managers configure capacity and allocations (server-validated, commerce-locked). */
const ROLES = ADMIN_POLICY.inventory;

export async function GET(): Promise<Response> {
  try {
    await authenticated([...ROLES]);
    return jsonOk({ zones: await inventoryOverview() });
  } catch (error) {
    return jsonError(error);
  }
}

/** One show × zone: { capacityId, version, ceiling, seasonAllocation, dailyAllocation, onlineSeasonAllocation }. */
export async function PATCH(request: Request): Promise<Response> {
  try {
    const user = await authenticated([...ROLES]);
    const body = await readJson<Record<string, unknown>>(request);
    if (typeof body.capacityId !== 'string') throw new AppError(400, 'capacityId is required.');
    return jsonOk(await configureCapacity(user, body.capacityId, body));
  } catch (error) {
    return jsonError(error);
  }
}

/** Season allocation for one zone across every upcoming performance: { zone, seasonAllocation, onlineSeasonAllocation }. */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated([...ROLES]);
    const body = await readJson<Record<string, unknown>>(request);
    return jsonOk(await configureSeasonForZone(user, String(body.zone ?? ''), body));
  } catch (error) {
    return jsonError(error);
  }
}
