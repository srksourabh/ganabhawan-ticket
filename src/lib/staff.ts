import { transaction, one, query, type Client } from './db';
import { decrypt, encrypt, generateTotpSecret, hashPassword, normalizeContact, otpauthUri, totpMatchStep } from './security';
import { audit } from './audit';
import { AppError, requireValue } from './errors';
import type { Role } from './types';

/**
 * Staff provisioning. These functions are used by the operator CLI
 * (scripts/staff.ts), which needs direct database access, i.e. owner-level
 * operational authority. No HTTP route exposes them, and no route returns
 * an MFA secret.
 */
export const STAFF_ROLES: readonly Role[] = ['owner', 'inventory', 'finance', 'desk', 'scanner', 'supervisor'];
const SCAN_ROLES: readonly Role[] = ['scanner', 'supervisor'];
export const MFA_ISSUER = 'Samatat Natyomela';

type StaffRow = {
  id: string;
  contact: string;
  name: string;
  role: Role;
  mfa_secret: string | null;
  mfa_pending_secret: string | null;
  mfa_enabled_at: string | null;
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
}) {
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
    await audit(c, null, 'staff.upsert', user.id, { role: input.role, scopesGranted: scopes });
    return { id: user.id, contact, role: input.role, scopesGranted: scopes, mfaEnabled: Boolean(user.mfa_secret) };
  });
}

/**
 * Step 1 of enrolment: a fresh secret is stored encrypted as *pending*. The
 * returned URI is shown once to the operator to render as a QR code. The
 * active secret (if any) is untouched until the staff member proves a code.
 */
export async function beginMfaEnrollment(contact: string) {
  return transaction(async (c) => {
    const user = await lockStaff(c, contact);
    requireValue(user.role !== 'customer', 'Only staff accounts use an authenticator.', 400);
    requireValue(!user.mfa_secret, 'MFA is already enabled for this account. Reset it first (db:staff mfa-reset).', 409);
    const secretKey = generateTotpSecret();
    await c.query('UPDATE users SET mfa_pending_secret=$1 WHERE id=$2', [encrypt(secretKey), user.id]);
    await audit(c, null, 'staff.mfa.enroll.start', user.id);
    return { uri: otpauthUri(user.contact, secretKey, MFA_ISSUER), secret: secretKey };
  });
}

/** Step 2: the staff member's first code activates the pending secret. */
export async function confirmMfaEnrollment(contact: string, code: string, nowMs = Date.now()) {
  return transaction(async (c) => {
    const user = await lockStaff(c, contact);
    requireValue(user.mfa_pending_secret, 'No pending enrolment. Run db:staff mfa-enroll first.', 409);
    const step = totpMatchStep(decrypt(user.mfa_pending_secret!), code.trim(), nowMs);
    if (step === null) {
      await audit(c, null, 'staff.mfa.enroll.failed', user.id);
      throw new AppError(400, 'That authenticator code is not valid. Check the phone clock and try the next code.');
    }
    await c.query(
      `UPDATE users SET mfa_secret=mfa_pending_secret, mfa_pending_secret=NULL, mfa_enabled_at=now(), mfa_last_step=$1 WHERE id=$2`,
      [step, user.id],
    );
    await c.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    await audit(c, null, 'staff.mfa.enabled', user.id);
    return { contact: user.contact, enabled: true };
  });
}

/** Lost phone / compromise: clears MFA and signs the account out everywhere. */
export async function resetMfa(contact: string, reason: string) {
  requireValue(reason.trim().length >= 3, 'Give a reason for the reset (recorded in the audit log).', 400);
  return transaction(async (c) => {
    const user = await lockStaff(c, contact);
    await c.query(
      'UPDATE users SET mfa_secret=NULL, mfa_pending_secret=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL WHERE id=$1',
      [user.id],
    );
    await c.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    await audit(c, null, 'staff.mfa.reset', user.id, { reason });
    return { contact: user.contact, reset: true };
  });
}

/** Removes staff access: role back to customer, scopes and sessions removed. */
export async function revokeStaff(contact: string, reason: string) {
  requireValue(reason.trim().length >= 3, 'Give a reason (recorded in the audit log).', 400);
  return transaction(async (c) => {
    const user = await lockStaff(c, contact);
    await c.query(
      "UPDATE users SET role='customer', password_hash=NULL, mfa_secret=NULL, mfa_pending_secret=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL WHERE id=$1",
      [user.id],
    );
    await c.query('DELETE FROM staff_scopes WHERE user_id=$1', [user.id]);
    await c.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    await audit(c, null, 'staff.revoke', user.id, { reason, previousRole: user.role });
    return { contact: user.contact, revoked: true };
  });
}

export async function listStaff() {
  return query<{ contact: string; name: string; role: string; mfa: boolean; password: boolean; upcoming_scopes: number }>(
    `SELECT u.contact, u.name, u.role, (u.mfa_secret IS NOT NULL) mfa, (u.password_hash IS NOT NULL) password,
      (SELECT count(DISTINCT sc.show_id)::int FROM staff_scopes sc JOIN shows s ON s.id=sc.show_id
        WHERE sc.user_id=u.id AND s.ends_at>now()) upcoming_scopes
     FROM users u WHERE u.role <> 'customer' ORDER BY u.role, u.contact`,
  );
}
