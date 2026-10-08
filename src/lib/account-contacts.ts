import { one, query, transaction } from './db';
import { AppError, requireValue } from './errors';
import { audit } from './audit';
import { keyedHash, normalizeContact, safeEqual } from './security';
import { requestOtp } from './auth';

/**
 * Verified contacts of an account. Purchase rule: a verified MOBILE is required;
 * email is optional. Both are verified by a code sent to them (the existing OTP
 * challenges): the sign-in contact by signing in, a mobile added to an email
 * account by verifyMobile below. Nothing unverified is ever stored here.
 */
export interface VerifiedContacts { email: string | null; mobile: string | null }

/** From users.contact (the sign-in contact) and users.verified_mobile. */
export function contactsOf(contact: string, verifiedMobile: string | null): VerifiedContacts {
  return contact.includes('@') ? { email: contact, mobile: verifiedMobile } : { email: null, mobile: contact };
}

export async function verifiedContacts(userId: string): Promise<VerifiedContacts> {
  const row = (await query<{ contact: string; verified_mobile: string | null }>('SELECT contact, verified_mobile FROM users WHERE id::text=$1', [userId]))[0];
  return row ? contactsOf(row.contact, row.verified_mobile) : { email: null, mobile: null };
}

/** Mobile only or email + mobile may buy; email only (or nothing) may not. Checked on the server before any hold. */
export async function assertCanPurchase(userId: string) {
  const { mobile } = await verifiedContacts(userId);
  if (!mobile) throw new AppError(409, 'Add and verify your mobile number before buying tickets.', 'MOBILE_REQUIRED');
}

/** Step 1: send a code to the mobile the signed-in customer wants to add. */
export async function requestMobileVerification(userId: string, raw: string, ip: string) {
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
