import { authenticated } from '@/lib/auth';
import { revokeStaff, setStaffPassword } from '@/lib/staff';
import { query } from '@/lib/db';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { ADMIN_POLICY, MANAGEABLE_STAFF_ROLES } from '@/lib/admin-policy';

/**
 * Owner-only actions on one staff account (scanner, supervisor, inventory, finance, desk):
 *   password    { password }   new password (12+ characters); signs the account out everywhere
 *   deactivate  { reason }     removes staff access (role → customer, password, scopes and sessions removed)
 * Owner accounts are managed with the operator CLI.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const owner = await authenticated(ADMIN_POLICY.staff);
    const { id } = await params;
    const target = (await query<{ contact: string; role: string }>(
      'SELECT contact, role FROM users WHERE id::text=$1', [id]))[0];
    if (!target || !MANAGEABLE_STAFF_ROLES.includes(target.role as never)) throw new AppError(404, 'Staff account not found.');
    const body = await readJson<{ action?: string; password?: string; reason?: string }>(request);
    switch (body.action) {
      case 'password':
        return jsonOk(await setStaffPassword(target.contact, String(body.password ?? ''), owner.id));
      case 'deactivate':
        return jsonOk(await revokeStaff(target.contact, String(body.reason ?? ''), owner.id));
      default:
        throw new AppError(400, 'Unknown action.');
    }
  } catch (error) {
    return jsonError(error);
  }
}
