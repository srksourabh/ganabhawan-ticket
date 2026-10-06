import { currentUser } from '@/lib/auth';
import { opsStatus } from '@/lib/ops';
import { jsonError, jsonOk } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { safeEqual } from '@/lib/security';

/**
 * Operational status for an external uptime monitor (Bearer OPS_MONITOR_TOKEN)
 * or a signed-in owner/finance user. HTTP 503 whenever a critical condition is
 * open, so any monitor that alerts on non-200 pages someone.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const monitorToken = process.env.OPS_MONITOR_TOKEN ?? '';
    const header = request.headers.get('authorization') ?? '';
    const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const viaMonitor = monitorToken.length >= 16 && presented.length > 0 && safeEqual(presented, monitorToken);
    if (!viaMonitor) {
      const user = await currentUser();
      if (!user) throw new AppError(401, 'Sign in required.');
      if (user.role !== 'owner' && user.role !== 'finance') throw new AppError(403, 'Only the owner and finance can view operations.');
    }
    const status = await opsStatus();
    return jsonOk(status, status.critical.length ? 503 : 200);
  } catch (error) {
    return jsonError(error);
  }
}
