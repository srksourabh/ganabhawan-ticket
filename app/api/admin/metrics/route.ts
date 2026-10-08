import { authenticated } from '@/lib/auth';
import { adminMetrics } from '@/lib/metrics';
import { jsonError, jsonOk } from '@/lib/http';
import { ADMIN_POLICY } from '@/lib/admin-policy';

/** Sales, admission and payment metrics (server-computed). Filters: showId, zone, from, to, scannerId, paymentStatus. */
export async function GET(request: Request): Promise<Response> {
  try {
    await authenticated(ADMIN_POLICY.metrics);
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    return jsonOk(await adminMetrics(params));
  } catch (error) {
    return jsonError(error);
  }
}
