import { guestSessionUser, openGuestSession, presentedSessionToken, rateLimit } from '@/lib/auth';
import { hash, keyedHash } from '@/lib/security';
import { clientIp, jsonError, jsonOk, readJson, setSessionCookie } from '@/lib/http';

/**
 * Starts (or keeps) a purchase-only guest checkout session from the name, email and mobile on
 * the booking form. No sign-up code, and no access to any account (auth.ts GUEST_TOKEN_PREFIX).
 * The same guest retrying keeps its session and is not counted. A NEW guest session is limited
 * per email (abuse of one address) and, more loosely, per network address: many genuine buyers
 * can share one address (venue or office Wi-Fi, mobile carriers).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson<{ name?: string; email?: string; phone?: string }>(request);
    const presented = await presentedSessionToken();
    const email = String(body?.email ?? '').trim().toLowerCase();
    const current = await guestSessionUser(presented);
    if (!current || current.contact.toLowerCase() !== email) {
      await rateLimit('guest-email:' + keyedHash(email), 10, 3600);
      await rateLimit('guest-ip:' + hash(clientIp(request)), 120, 3600);
    }
    const result = await openGuestSession(body?.name ?? '', body?.email ?? '', body?.phone ?? '', presented);
    const response = jsonOk({ guest: true, name: result.user.name });
    return result.reused ? response : setSessionCookie(response, result.sessionToken);
  } catch (error) {
    return jsonError(error);
  }
}
