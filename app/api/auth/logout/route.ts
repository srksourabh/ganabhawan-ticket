import { presentedSessionToken, revokeSession } from '@/lib/auth';
import { clearSessionCookie, jsonError, jsonOk } from '@/lib/http';

/** Deletes the presented session server-side (cookie or bearer), then clears the cookie. */
export async function POST(): Promise<Response> {
  try {
    await revokeSession(await presentedSessionToken());
    return clearSessionCookie(jsonOk({ ok: true }));
  } catch (error) {
    return jsonError(error);
  }
}
