import { one, query, transaction } from './db';
import { AppError, requireValue } from './errors';
import { audit } from './audit';
import { keyedHash, normalizeContact, safeEqual } from './security';
import { assertMobileAvailable, requestOtp } from './auth';
import { mobileFeaturesEnabled } from './env';

/**
 * Verified contacts of an account. Purchase rule: at least ONE verified contact
 * (email only, mobile only, or both). Each is verified by a code sent to it (the
 * existing OTP challenges) or by Google: the sign-in contact by signing in, an
 * optional mobile added to an email account by verifyMobile below. Nothing
 * unverified is ever stored here. Confirmations go to every verified contact.
 */
export interface VerifiedContacts { email: string | null; mobile: string | null }

/** From users.contact (the sign-in contact) and users.verified_mobile. */
export function contactsOf(contact: string, verifiedMobile: string | null): VerifiedContacts {
  if (contact.includes('@')) return { email: contact, mobile: verifiedMobile };
  return { email: null, mobile: /^\+[1-9]\d{7,14}$/.test(contact) ? contact : null }; // anything else is no usable contact
}

export async function verifiedContacts(userId: string): Promise<VerifiedContacts> {
  const row = (await query<{ contact: string; verified_mobile: string | null }>('SELECT contact, verified_mobile FROM users WHERE id::text=$1', [userId]))[0];
  return row ? contactsOf(row.contact, row.verified_mobile) : { email: null, mobile: null };
}

/**
 * Email only, mobile only or both may buy; an account with neither may not. While mobile
 * features are off (MOBILE_PHONE_NUMBER_ENABLED) a mobile cannot carry the confirmation,
 * so a verified email is required. Checked on the server before any hold.
 */
export async function assertCanPurchase(userId: string) {
  const { email, mobile } = await verifiedContacts(userId);
  if (email || (mobile && mobileFeaturesEnabled())) return;
  throw new AppError(409, mobileFeaturesEnabled()
    ? 'A verified email address or mobile number is required to buy tickets.'
    : 'A verified email address is required to buy tickets.', 'CONTACT_REQUIRED');
}

/** Step 1: send a code to the mobile the signed-in customer wants to add. */
export async function requestMobileVerification(userId: string, raw: string, ip: string) {
  assertMobileAvailable();
  let mobile: string;
  try { mobile = normalizeContact(raw); } catch { throw new AppError(400, 'Enter a valid mobile number with country code, for example +91.'); }
  requireValue(!mobile.includes('@'), 'Enter a mobile number, not an email.', 400);
  await assertMobileFree(userId, mobile);
  const { challengeId, message } = await requestOtp(mobile, ip);
  return { challengeId, message };
}

async function assertMobileFree(userId: string, mobile: string) {
  const taken = (await query('SELECT 1 FROM users WHERE id<>$1 AND (contact=$2 OR verified_mobile=$2)', [userId, mobile]))[0];
  requireValue(!taken, 'This mobile number belongs to another account. Sign in with it instead.', 409);
}

/** Step 2: the code proves the number; only then is it stored as the account's verified mobile. */
export async function verifyMobile(userId: string, challengeId: string, code: string) {
  assertMobileAvailable();
  const result = await transaction(async (c) => {
    const challenge = await one<{ id: string; contact: string; digest: string; used: boolean; expires_at: string; attempts: number }>(
      c, 'SELECT * FROM otp_challenges WHERE id::text=$1 FOR UPDATE', [challengeId]);
    if (!challenge || challenge.used || new Date(challenge.expires_at).getTime() < Date.now() || challenge.attempts >= 5 || challenge.contact.includes('@')) {
      return { error: 'This code has expired or is no longer valid.' };
    }
    await c.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
    if (!safeEqual(challenge.digest, keyedHash(challenge.contact + ':' + code.trim()))) return { error: 'The code is incorrect. Please try again.' };
    const taken = await one(c, 'SELECT 1 FROM users WHERE id<>$1 AND (contact=$2 OR verified_mobile=$2)', [userId, challenge.contact]);
    if (taken) return { error: 'This mobile number belongs to another account. Sign in with it instead.' };
    await c.query('UPDATE otp_challenges SET used=true WHERE id=$1', [challenge.id]);
    await c.query("UPDATE users SET verified_mobile=$1, mobile_verified_at=now() WHERE id=$2 AND contact LIKE '%@%'", [challenge.contact, userId]);
    await audit(c, userId, 'account.mobile.verified', userId);
    return { mobile: challenge.contact };
  });
  if ('error' in result) throw new AppError(400, result.error!);
  return result;
}
