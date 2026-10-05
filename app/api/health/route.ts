import { query } from '@/lib/db';
import { appMode, configurationProblems, deployEnv } from '@/lib/env';
import { jsonOk } from '@/lib/http';

/**
 * Public liveness/readiness. Reports mode and booleans only, never names of
 * missing secrets or any value. 503 when the database is unreachable or the
 * configuration is unsafe (the proxy refuses API traffic in that state too).
 */
export async function GET(): Promise<Response> {
  let db = false;
  try {
    // A hung connection must read as unhealthy, not hang the monitor.
    await Promise.race([
      query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 5000)),
    ]);
    db = true;
  } catch {
    db = false;
  }
  const config = configurationProblems().length === 0;
  const ok = db && config;
  return jsonOk({ ok, db, config, mode: appMode(), env: deployEnv() ?? 'local' }, ok ? 200 : 503);
}
