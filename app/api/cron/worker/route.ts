import { processJobs, workerTickLimits } from '@/lib/jobs';
import { jsonOk, jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { safeEqual } from '@/lib/security';

/**
 * One worker tick. Called every minute by the Worker's Cron Trigger
 * (worker/index.ts) and, as a fallback, by GitHub Actions. Batch sizes fit a
 * Worker invocation's subrequest limit (workerTickLimits).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) throw new AppError(503, 'Cron not configured.');

    const authHeader = request.headers.get('Authorization') ?? '';
    const presented = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    if (!presented || !safeEqual(presented, cronSecret)) {
      throw new AppError(401, 'Unauthorized.');
    }

    const processed = await processJobs(workerTickLimits());
    // A step that threw is reported as a failed tick so the scheduler and monitors see it.
    return jsonOk({ ok: processed.errors.length === 0, processed }, processed.errors.length ? 500 : 200);
  } catch (error) {
    return jsonError(error);
  }
}
