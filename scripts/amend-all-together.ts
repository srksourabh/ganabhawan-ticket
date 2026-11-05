/**
 * Adds one programme to All Together — Every Play and gives every existing CONFIRMED pass an
 * explicit entitlement to it (src/lib/programme-inclusion.ts amendExistingPasses): one
 * transaction, audited, idempotent (a second run changes nothing). Booking amounts, snapshots
 * and payments are never changed and no payment order is created.
 *
 *   npx tsx scripts/amend-all-together.ts --show=<show uuid> --reason="…" --include --notify --dry-run
 *   ENV_FILE=.env.local npx tsx scripts/amend-all-together.ts … --confirm-host=<exact database host>
 *
 * Target: DATABASE_URL from the shell, else from ENV_FILE (default .env.local). Only the
 * database URL is read from the file; nothing else is loaded. A non-local database is refused
 * unless --confirm-host names its exact host. Credentials are never printed.
 *
 * --include   also include the programme in every All Together pass (new purchases)
 * --notify    queue one booking-update notice per amended pass (NOTICE job, unique key). On a later
 *             run it queues the notice for passes amended earlier without one (never twice, and
 *             never for a pass that included the programme at purchase).
 * --dry-run   compute and print what would change, then roll everything back
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';

if (!process.env.DATABASE_URL) {
  const file = process.env.ENV_FILE || '.env.local';
  if (!existsSync(file)) throw new Error(`No DATABASE_URL in the shell and ${file} does not exist.`);
  const url = parse(readFileSync(file)).DATABASE_URL?.trim();
  if (!url) throw new Error(`${file} has no DATABASE_URL.`);
  process.env.DATABASE_URL = url;
}
const target = new URL(process.env.DATABASE_URL!);
const local = ['127.0.0.1', 'localhost', '::1'].includes(target.hostname);
console.log(`Target: database "${target.pathname.slice(1)}" on ${target.hostname} (${local ? 'LOCAL' : 'REMOTE'})`);
if (!local && value('confirm-host') !== target.hostname) {
  console.error(`Refusing to change a remote database. Re-run with --confirm-host=${target.hostname} after taking a backup.`);
  process.exit(2);
}
const showId = value('show');
if (!/^[0-9a-f-]{36}$/i.test(showId)) { console.error('Give --show=<programme uuid>.'); process.exit(2); }
const reason = value('reason');

const { amendExistingPasses } = await import('../src/lib/programme-inclusion');
const { pool } = await import('../src/lib/db');
try {
  const result = await amendExistingPasses({ id: null, label: 'operator script amend-all-together' }, showId, {
    reason, notify: flag('notify'), include: flag('include'), dryRun: flag('dry-run'),
  });
  console.log(`${flag('dry-run') ? 'DRY RUN (rolled back)' : 'APPLIED'}: "${result.title}" ${result.included ? 'included in All Together; ' : ''}`
    + `${result.amended.length} pass(es) amended, ${result.skipped} already had it, ${result.noticesQueued} notice(s) queued.`);
  for (const a of result.amended) {
    console.log(`  ${a.reference}  booking ${a.bookingId}  customer ${a.customerId}  tickets ${a.quantity}  programmes ${a.previousProgrammeCount} -> ${a.newProgrammeCount}${a.notified ? '  notice queued' : ''}`);
  }
} finally {
  await pool.end().catch(() => undefined);
}
