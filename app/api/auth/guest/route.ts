import { openGuestSession, rateLimit } from '@/lib/auth';
import { hash } from '@/lib/security';
import { clientIp, jsonError, jsonOk, readJson, setSessionCookie } from '@/lib/http';

/** Starts a guest checkout session from the name, email and mobile on the booking form. No sign-up code. */
export async function POST(request: Request): Promise<Response> {
  try {
    await rateLimit('guest-ip:' + hash(clientIp(request)), 30, 3600);
    const body = await readJson<{ name?: string; email?: string; phone?: string }>(request);
    const result = await openGuestSession(body.name ?? '', body.email ?? '', body.phone ?? '');
    return setSessionCookie(jsonOk({ id: result.user.id, contact: result.user.contact, name: result.user.name }), result.sessionToken);
  } catch (error) {
    return jsonError(error);
  }
}
