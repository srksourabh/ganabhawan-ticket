import { query } from '@/lib/db';
import { appMode, configurationProblems, coreConfigurationProblems, deployEnv, mobileFeaturesEnabled } from '@/lib/env';
import { jsonOk } from '@/lib/http';

/**
 * Public liveness/readiness. Reports mode and booleans only, never names of
 * missing secrets or any value. 503 when the database is unreachable or the
 * configuration is unsafe (the proxy refuses API traffic in that state too).
 */
export async function GET(): Promise<Response> {
  // A hung connection must read as unhealthy, not hang the monitor: every query is bounded.
  const bounded = <T,>(work: Promise<T>) =>
    Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('db timeout')), 5000))]);
  let db = false;
  try {
    await bounded(query('SELECT 1'));
    db = true;
  } catch {
    db = false;
  }
  const config = configurationProblems().length === 0;
  // Staff sign-in, admin and gate scanning need only the core settings.
  const staff = coreConfigurationProblems().length === 0;
  // Customer mobile sign-in + SMS (MOBILE_PHONE_NUMBER_ENABLED and MSG91 complete). Not part of `ok`.
  const mobile = mobileFeaturesEnabled();
  // The deploy workflow does not migrate: report a schema behind the code (e.g. 0007 not applied).
  let schema = false;
  if (db) {
    try {
      schema = (await bounded(query<{ ok: boolean }>("SELECT to_regclass('public.checkouts') IS NOT NULL AS ok")))[0]?.ok === true;
    } catch {
      schema = false;
    }
  }
  const ok = db && config && schema;
  return jsonOk({ ok, db, config, staff, mobile, schema, mode: appMode(), env: deployEnv() ?? 'local' }, ok ? 200 : 503);
}
