/** The Cron Trigger's tick, separated from the vinext entry so it can be tested in Node. */
export type CronEnv = { CRON_SECRET?: string; APP_URL?: string };

/**
 * Calls the app's own authenticated /api/cron/worker route in-process, so the
 * tick runs exactly the code the GitHub Actions fallback reaches over HTTP,
 * with the same CRON_SECRET check. Throws on failure so Cloudflare records the
 * cron invocation as failed.
 */
export async function runScheduledTick(app: (request: Request) => Promise<Response>, env: CronEnv): Promise<void> {
  if (!env.CRON_SECRET || !env.APP_URL) {
    throw new Error('[cron] CRON_SECRET and APP_URL must be set for the worker tick');
  }
  const response = await app(new Request(new URL('/api/cron/worker', env.APP_URL), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_SECRET}`, 'Content-Type': 'application/json' },
  }));
  const body = await response.text();
  console.log('[cron] tick', response.status, body.slice(0, 500));
  if (!response.ok) throw new Error(`[cron] worker tick failed with HTTP ${response.status}`);
}
