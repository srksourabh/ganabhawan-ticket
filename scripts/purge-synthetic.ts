/**
 * Neutralises the synthetic seed accounts (…@example.test) in a shared database.
 * Dry run by default; pass --apply to change anything. Nothing is deleted:
 * accounts are demoted to customers with no password/MFA/Clerk link, their
 * gate scopes and sessions are removed, and one audit event is written.
 * Bookings and payments are reported, never touched.
 *
 *   npm run db:purge-synthetic            # report only
 *   npm run db:purge-synthetic -- --apply # demote + revoke
 */
import { config } from 'dotenv';
config({ path: process.env.ENV_FILE || '.env.local', quiet: true });

import { pool, transaction } from '../src/lib/db';
import { audit } from '../src/lib/audit';
import { assertScriptTarget } from './script-env';

assertScriptTarget('db:purge-synthetic');

const apply = process.argv.includes('--apply');
const PATTERN = '%@example.test';

try {
  const report = await transaction(async (c) => {
    const users = (await c.query<{ id: string; contact: string; role: string }>(
      "SELECT id, contact, role FROM users WHERE contact LIKE $1 ORDER BY contact FOR UPDATE",
      [PATTERN],
    )).rows;
    const ids = users.map((u) => u.id);
    const counts = (await c.query<{ sessions: number; scopes: number; bookings: number; payments: number }>(
      `SELECT (SELECT count(*) FROM sessions WHERE user_id = ANY($1::uuid[]))::int sessions,
              (SELECT count(*) FROM staff_scopes WHERE user_id = ANY($1::uuid[]))::int scopes,
              (SELECT count(*) FROM bookings WHERE user_id = ANY($1::uuid[]))::int bookings,
              (SELECT count(*) FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.user_id = ANY($1::uuid[]))::int payments`,
      [ids],
    )).rows[0];
    if (apply && ids.length) {
      await c.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [ids]);
      await c.query('DELETE FROM staff_scopes WHERE user_id = ANY($1::uuid[])', [ids]);
      await c.query(
        `UPDATE users SET role='customer', password_hash=NULL, mfa_secret=NULL, mfa_pending_secret=NULL,
         mfa_enabled_at=NULL, mfa_last_step=NULL, clerk_id=NULL WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      await audit(c, null, 'synthetic.purge', 'users', { demoted: users.map((u) => u.contact) });
    }
    return { users, counts };
  });
  console.table(report.users.map((u) => ({ contact: u.contact, roleBefore: u.role })));
  console.log(report.counts);
  console.log(apply ? 'Applied: synthetic accounts demoted, sessions and scopes removed.' : 'Dry run. Re-run with --apply to demote these accounts.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
