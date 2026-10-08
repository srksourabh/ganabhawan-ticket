import { authenticated } from '@/lib/auth';
import { listStaff, upsertStaff } from '@/lib/staff';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { AppError } from '@/lib/errors';
import type { Role } from '@/lib/types';
import { ADMIN_POLICY, MANAGEABLE_STAFF_ROLES } from '@/lib/admin-policy';

/**
 * Owner-only staff management. The dashboard can create scanner, supervisor,
 * inventory, finance and desk accounts (never another owner: operator CLI only).
 * Passwords are hashed by upsertStaff and never returned. Re-adding a deactivated
 * person with the same email reactivates them with the new role and password.
 */
export async function GET(): Promise<Response> {
  try {
    await authenticated(ADMIN_POLICY.staff);
    return jsonOk({ staff: await listStaff() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.staff);
    const body = await readJson<{ email?: string; name?: string; role?: string; password?: string }>(request);
    const role = (body.role ?? 'scanner') as Role;
    if (!MANAGEABLE_STAFF_ROLES.includes(role)) throw new AppError(400, `Choose one of: ${MANAGEABLE_STAFF_ROLES.join(', ')}.`);
    const email = String(body.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Enter the staff member\'s email address.');
    const existing = await listStaff().then((rows) => rows.find((r) => r.contact === email.toLowerCase()));
    if (existing?.role === 'owner') throw new AppError(409, 'That email belongs to an owner account.');
    if (!body.password) throw new AppError(400, 'Set an initial password (at least 12 characters).');
    const created = await upsertStaff({ contact: email, role, name: String(body.name ?? ''), password: body.password }, user.id);
    return jsonOk(created, 201);
  } catch (error) {
    return jsonError(error);
  }
}
