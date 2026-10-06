import { processJobs } from '@/lib/jobs';
import { jsonOk, jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { safeEqual } from '@/lib/security';

export async function POST(request: Request): Promise<Response> {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) throw new AppError(503, 'Cron not configured.');

    const authHeader = request.headers.get('Authorization') ?? '';
    const presented = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    if (!presented || !safeEqual(presented, cronSecret)) {
      throw new AppError(401, 'Unauthorized.');
    }

    const processed = await processJobs(20);
    return jsonOk({ ok: true, processed });
  } catch (error) {
    return jsonError(error);
  }
}
