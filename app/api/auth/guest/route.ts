import { openGuestSession, presentedSessionToken, rateLimit } from '@/lib/auth';
import { hash } from '@/lib/security';
import { clientIp, jsonError, jsonOk, readJson, setSessionCookie } from '@/lib/http';

/**
 * Starts (or keeps) a purchase-only guest checkout session from the name, email and mobile on
 * the booking form. No sign-up code, and no access to any account (auth.ts GUEST_TOKEN_PREFIX).
 * The same guest retrying keeps its session.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    await rateLimit('guest-ip:' + hash(clientIp(request)), 30, 3600);
    const body = await readJson<{ name?: string; email?: string; phone?: string }>(request);
    const result = await openGuestSession(body?.name ?? '', body?.email ?? '', body?.phone ?? '', await presentedSessionToken());
    const response = jsonOk({ guest: true, name: result.user.name });
    return result.reused ? response : setSessionCookie(response, result.sessionToken);
  } catch (error) {
    return jsonError(error);
  }
}
