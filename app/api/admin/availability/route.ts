import { authenticated } from '@/lib/auth';
import { performanceSalesOverview } from '@/lib/performance-sales';
import { jsonOk, jsonError } from '@/lib/http';
import { ADMIN_POLICY } from '@/lib/admin-policy';

/** Every performance with each zone's daily capacity, remaining seats, sale state and the reason. */
export async function GET(): Promise<Response> {
  try {
    await authenticated([...ADMIN_POLICY.catalogue]);
    return jsonOk({ performances: await performanceSalesOverview() });
  } catch (error) {
    return jsonError(error);
  }
}
