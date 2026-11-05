import { authenticated } from '@/lib/auth';
import { ADMIN_POLICY } from '@/lib/admin-policy';
import { pricingOverview, setZonePrice } from '@/lib/pricing';
import { jsonOk, jsonError, readJson } from '@/lib/http';

/** The shared per-programme price of each zone and every All Together breakdown (pricing.ts). */
export async function GET(): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    return jsonOk(await pricingOverview(user));
  } catch (error) {
    return jsonError(error);
  }
}

/** Sets one zone's per-programme price: { zone, price (paise), version? }. Daily tickets follow; All Together re-prices. */
export async function PUT(request: Request): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    return jsonOk(await setZonePrice(user, await readJson<Record<string, unknown>>(request)));
  } catch (error) {
    return jsonError(error);
  }
}
