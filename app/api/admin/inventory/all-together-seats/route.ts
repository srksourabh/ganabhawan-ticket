import { authenticated } from '@/lib/auth';
import { ADMIN_POLICY } from '@/lib/admin-policy';
import { addAllTogetherSeats } from '@/lib/inventory-admin';
import { jsonError, jsonOk, readJson } from '@/lib/http';

/** Adds All Together seats to one zone across every programme its pass covers: { zone, seats, expectedAvailable }. */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated([...ADMIN_POLICY.inventory]);
    return jsonOk(await addAllTogetherSeats(user, await readJson<Record<string, unknown>>(request)));
  } catch (error) {
    return jsonError(error);
  }
}
