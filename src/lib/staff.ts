import { transaction, one, query, type Client } from './db';
import { hashPassword, normalizeContact } from './security';
import { audit } from './audit';
import { requireValue } from './errors';
import type { Role } from './types';

/**
 * Staff provisioning, used by the operator CLI (scripts/staff.ts) and by the
 * owner-only staff routes (app/api/admin/staff). Staff sign in with email +
 * password (auth.ts loginStaff); passwords are stored only as scrypt hashes.
 * `actorId` is the owner acting through the dashboard (null for the CLI).
 */
export const STAFF_ROLES: readonly Role[] = ['owner', 'inventory', 'finance', 'desk', 'scanner', 'supervisor'];
const SCAN_ROLES: readonly Role[] = ['scanner', 'supervisor'];

type StaffRow = {
  id: string;
  contact: string;
  name: string;
  role: Role;
};

async function lockStaff(c: Client, contact: string) {
  const normalized = normalizeContact(contact);
  const user = await one<StaffRow>(c, 'SELECT * FROM users WHERE contact=$1 FOR UPDATE', [normalized]);
  requireValue(user, 'No user with that contact.', 404);
  return user!;
}

/** Scopes a scanner/supervisor for every not-yet-ended show on every active device. */
export async function grantUpcomingScopes(c: Client, userId: string) {
  const result = await c.query(
    `INSERT INTO staff_scopes(user_id,show_id,gate,device_id)
     SELECT $1, s.id, d.id, d.id FROM shows s CROSS JOIN devices d
     WHERE s.ends_at > now() AND s.status <> 'CANCELLED' AND d.revoked = false
     ON CONFLICT DO NOTHING RETURNING show_id`,
    [userId],
  );
  return result.rows.length;
}

export async function upsertStaff(input: {
  contact: string;
  role: Role;
  name?: string;
  password?: string;
  username?: string;
}, actorId: string | null = null) {
  requireValue(STAFF_ROLES.includes(input.role), `Role must be one of: ${STAFF_ROLES.join(', ')}.`, 400);
  if (input.password !== undefined) requireValue(input.password.length >= 12, 'Staff passwords need at least 12 characters.', 400);
  const contact = normalizeContact(input.contact);
  return transaction(async (c) => {
    await c.query(`INSERT INTO devices(id,name) VALUES('gate-one','Main entrance'),('gate-two','Balcony entrance') ON CONFLICT(id) DO NOTHING`);
    let user = await one<StaffRow>(c, 'SELECT * FROM users WHERE contact=$1 FOR UPDATE', [contact]);
    const passwordHash = input.password ? hashPassword(input.password) : null;
    if (user) {
      await c.query(
        `UPDATE users SET role=$1, name=CASE WHEN $2<>'' THEN $2 ELSE name END,
         password_hash=COALESCE($3,password_hash), username=COALESCE($4,username) WHERE id=$5`,
        [input.role, input.name ?? '', passwordHash, input.username ?? null, user.id],
      );
      // A role change must not ride on sessions issued under the old role.
      if (user.role !== input.role) await c.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    } else {
      user = (await one<StaffRow>(
        c,
        'INSERT INTO users(contact,name,role,password_hash,username) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [contact, input.name ?? '', input.role, passwordHash, input.username ?? null],
      ))!;
    }
    const scopes = SCAN_ROLES.includes(input.role) ? await grantUpcomingScopes(c, user.id) : 0;
    await audit(c, actorId, 'staff.upsert', user.id, { role: input.role, scopesGranted: scopes });
    return { id: user.id, contact, role: input.role, scopesGranted: scopes };
  });
}

/** Removes staff access: role back to customer, password removed, scopes and sessions removed (legacy MFA columns cleared too). */
export async function revokeStaff(contact: string, reason: string, actorId: string | null = null) {
  requireValue(reason.trim().length >= 3, 'Give a reason (recorded in the audit log).', 400);
  return transaction(async (c) => {
    const user = await lockStaff(c, contact);
    await c.query(
      "UPDATE users SET role='customer', password_hash=NULL, mfa_secret=NULL, mfa_pending_secret=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL WHERE id=$1",
      [user.id],
    );
    await c.query('DELETE FROM staff_scopes WHERE user_id=$1', [user.id]);
    await c.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    await audit(c, actorId, 'staff.revoke', user.id, { reason, previousRole: user.role });
    return { contact: user.contact, revoked: true };
  });
}

/** New password for a staff account; every existing session is signed out. */
export async function setStaffPassword(contact: string, password: string, actorId: string | null = null) {
  requireValue(password.length >= 12, 'Staff passwords need at least 12 characters.', 400);
  return transaction(async (c) => {
    const user = await lockStaff(c, contact);
    requireValue(user.role !== 'customer', 'Only staff accounts have a password.', 400);
    await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(password), user.id]);
    await c.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    await audit(c, actorId, 'staff.password.reset', user.id);
    return { contact: user.contact, passwordReset: true };
  });
}

export async function listStaff() {
  return query<{ id: string; contact: string; name: string; role: string; password: boolean; upcoming_scopes: number }>(
    `SELECT u.id, u.contact, u.name, u.role, (u.password_hash IS NOT NULL) password,
      (SELECT count(DISTINCT sc.show_id)::int FROM staff_scopes sc JOIN shows s ON s.id=sc.show_id
        WHERE sc.user_id=u.id AND s.ends_at>now()) upcoming_scopes
     FROM users u WHERE u.role <> 'customer' ORDER BY u.role, u.contact`,
  );
}
