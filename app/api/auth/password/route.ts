import { isStaffPortal, loginStaff } from '@/lib/auth';
import { AppError } from '@/lib/errors';
import { clientIp, jsonOk, jsonError, readJson, setSessionCookie } from '@/lib/http';

/**
 * Staff sign-in (email or username + password). `portal` is the door used:
 * 'admin' (/admin/login: owner, inventory, finance, desk) or 'gate' (/gate/login:
 * scanner, supervisor). The role check happens on the server before a session exists.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson<{ email?: string; username?: string; password?: string; portal?: string }>(request);
    if (!isStaffPortal(body.portal)) throw new AppError(400, 'Sign in from /admin/login or /gate/login.');
    const identifier = body.email || body.username || '';
    const result = await loginStaff(identifier, body.password ?? '', body.portal, clientIp(request));
    const mobile = request.headers.get('x-client') === 'mobile';
    const response = jsonOk(mobile ? { user: result.user, sessionToken: result.sessionToken } : { user: result.user });
    return setSessionCookie(response, result.sessionToken!);
  } catch (error) {
    return jsonError(error);
  }
}
