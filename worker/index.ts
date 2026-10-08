/**
 * Cloudflare Worker entry: the vinext app plus a Cron Trigger.
 *
 * fetch     → the vinext app, unchanged.
 * scheduled → one background tick (hold expiry, payment reconciliation,
 *             refunds, confirmation emails) per wrangler.jsonc `triggers.crons`.
 */
import handler from 'vinext/server/fetch-handler';
import { runScheduledTick, type CronEnv } from './scheduled';

type WorkerEnv = CronEnv & { ASSETS?: { fetch(request: Request): Promise<Response> | Response } };
type Ctx = { waitUntil(promise: Promise<unknown>): void; passThroughOnException?(): void };

export default {
  fetch(request: Request, env: WorkerEnv, ctx: Ctx): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },

  scheduled(_controller: { cron: string; scheduledTime: number }, env: WorkerEnv, ctx: Ctx): Promise<void> {
    return runScheduledTick((request) => handler.fetch(request, env, ctx), env);
  },
};
