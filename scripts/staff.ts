/**
 * Staff accounts, roles and gate scopes. Operator-only: needs DATABASE_URL for
 * the target environment, so whoever runs it already holds owner-level access.
 * Staff sign in with email + password (admin roles at /admin/login, gate roles
 * at /gate/login).
 *
 *   npm run db:staff -- list
 *   STAFF_PASSWORD='…' npm run db:staff -- add <email> <role> [name]
 *   npm run db:staff -- scopes <email>              # re-grant gates for upcoming shows
 *   npm run db:staff -- revoke <email> "<reason>"
 *
 * The password is read from STAFF_PASSWORD so it never lands in shell history.
 */
import { config } from 'dotenv';
config({ path: process.env.ENV_FILE || '.env.local', quiet: true });

import { transaction } from '../src/lib/db';
import { pool } from '../src/lib/db';
import { normalizeContact } from '../src/lib/security';
import {
  STAFF_ROLES, grantUpcomingScopes, listStaff, revokeStaff, upsertStaff,
} from '../src/lib/staff';
import type { Role } from '../src/lib/types';
import { assertScriptTarget } from './script-env';

assertScriptTarget('db:staff');

const [command, ...args] = process.argv.slice(2);

function usage(): never {
  console.error('Usage: npm run db:staff -- <list|add|scopes|revoke> …  (see scripts/staff.ts)');
  process.exit(2);
}

try {
  switch (command) {
    case 'list':
      console.table(await listStaff());
      break;
    case 'add': {
      const [contact, role, ...name] = args;
      if (!contact || !role) usage();
      if (!STAFF_ROLES.includes(role as Role)) throw new Error(`Role must be one of: ${STAFF_ROLES.join(', ')}`);
      const result = await upsertStaff({ contact, role: role as Role, name: name.join(' '), password: process.env.STAFF_PASSWORD || undefined });
      console.log(`Staff ready: ${result.contact} (${result.role}); gate scopes granted: ${result.scopesGranted}`);
      break;
    }
    case 'scopes': {
      const [contact] = args;
      if (!contact) usage();
      const n = await transaction(async (c) => {
        const user = (await c.query<{ id: string }>('SELECT id FROM users WHERE contact=$1', [normalizeContact(contact)])).rows[0];
        if (!user) throw new Error('No user with that contact.');
        return grantUpcomingScopes(c, user.id);
      });
      console.log(`New gate scopes granted: ${n}`);
      break;
    }
    case 'revoke': {
      const [contact, ...reason] = args;
      if (!contact) usage();
      await revokeStaff(contact, reason.join(' '));
      console.log('Staff access removed.');
      break;
    }
    default:
      usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
