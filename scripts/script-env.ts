/**
 * Guard for operator scripts that write to a database. Load the target
 * environment with ENV_FILE (default .env.local); a development configuration
 * may only touch a local database.
 */
import { devMode, isLoopbackDatabase, usingDevelopmentPayments } from '../src/lib/env';

export function assertScriptTarget(purpose: string) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set. Use ENV_FILE=.env.staging or .env.production.');
  if (!isLoopbackDatabase() && (devMode() || usingDevelopmentPayments())) {
    let host = 'the target';
    try { host = new URL(process.env.DATABASE_URL).hostname; } catch { /* keep generic */ }
    throw new Error(
      `Refusing to run ${purpose} against ${host} with a development configuration (APP_MODE/PAYMENT_PROVIDER from ${process.env.ENV_FILE || '.env.local'}). ` +
      'Load the matching environment, e.g. ENV_FILE=.env.production npm run …',
    );
  }
}
