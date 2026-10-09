import { randomInt } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { auth, currentUser as clerkCurrentUser } from '@clerk/nextjs/server';
import { query, transaction, one } from './db';
import { assertLiveConfiguration, assertStaffConfiguration, developmentAdaptersAllowed, mobileConfigurationProblems, mobileFeaturesEnabled } from './env';
import { keyedHash, normalizeContact, token, hash, safeEqual, hashPassword, verifyPassword } from './security';
import type { Client } from './db';
import { AppError, requireValue } from './errors';
import type { User, Role } from './types';
import { audit } from './audit';
import { otpProvider } from './httpsms';
import { SmsDisabledError, otpSmsConfigured, sendFreeTextSms, sendOtpSms, smsProvider } from './sms';
import { composioGmailConfigured, sendComposioGmail } from './composio-gmail';

export async function rateLimit(key: string, limit: number, seconds: number) {
  const rows = await query(
    `INSERT INTO rate_limits(key,count,reset_at) VALUES($1,1,now()+$2*interval '1 second')
 ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<now() THEN 1 ELSE rate_limits.count+1 END,
 reset_at=CASE WHEN rate_limits.reset_at<now() THEN excluded.reset_at ELSE rate_limits.reset_at END RETURNING count`,
    [key, seconds],
  );
  if (rows[0].count > limit) throw new AppError(429, 'Too many attempts. Please wait before trying again.');
}

/**
 * Plain-text email via Composio Gmail or Resend. `idempotencyKey` (Resend's
 * Idempotency-Key, honoured for 24 h) makes a retried job that already sent
 * the email — e.g. the send succeeded but marking the job done failed — a no-op
 * at the provider instead of a second email. No-op in local development.
 */
export async function sendEmail(to: string, subject: string, message: string, idempotencyKey?: string) {
  if (composioGmailConfigured()) {
    await sendComposioGmail(to, subject, message);
    return;
  }
  if (developmentAdaptersAllowed() && otpProvider() === 'development') return;
  requireValue(process.env.RESEND_API_KEY && process.env.EMAIL_FROM, 'Email delivery is not configured.', 503);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}),
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text: message }),
    signal: AbortSignal.timeout(10000),
  });
  requireValue(response.ok, 'Email delivery is temporarily unavailable.', 503);
}

/**
 * A free-text message: email to an address. A mobile gets free text only through a
 * local development gateway: MSG91 (live) sends approved templates only, so sign-in
 * codes, confirmations and notices go through sms.ts (sendOtpSms / sendSms / sendNoticeSms).
 */
export async function sendMessage(contact: string, subject: string, message: string, requestId?: string) {
  const phone = !contact.includes('@');
  const viaComposio = !phone && composioGmailConfigured();
  // Silent no-op delivery exists only for local development; live mode must really send.
  if (phone && !mobileFeaturesEnabled()) throw new SmsDisabledError(); // no SMS gateway at all while mobile is off
  if (developmentAdaptersAllowed() && otpProvider() === 'development' && !viaComposio && (!phone || smsProvider() === 'none')) return;

  if (!phone) {
    await sendEmail(contact, subject, message);
    return;
  }
  requireValue(smsProvider() !== 'msg91', 'Free-text SMS is not available: MSG91 sends approved templates only.', 503);
  await sendFreeTextSms(contact, message, requestId);
}

/** The sign-in code: email to an address; the MSG91 OTP template to a mobile. */
async function sendCode(contact: string, code: string, subject: string, text: string, requestId: string) {
  if (contact.includes('@')) return sendMessage(contact, subject, text, requestId);
  // Local development without an SMS gateway: the code is shown on the page instead.
  if (developmentAdaptersAllowed() && otpProvider() === 'development' && !otpSmsConfigured()) return;
  await sendOtpSms(contact, code, text, requestId);
}

/**
 * Staff sign in with email (or username) + password only, at one of two doors.
 * Each door admits only its roles; the check runs on the server before any
 * session exists. The owner uses the admin door and keeps every existing
 * permission (including scanning at /gate).
 */
export type StaffPortal = 'admin' | 'gate';
export const PORTAL_ROLES: Record<StaffPortal, readonly Role[]> = {
  admin: ['owner', 'inventory', 'finance', 'desk'],
  gate: ['scanner', 'supervisor'],
};
export const PORTAL_LOGIN: Record<StaffPortal, string> = { admin: '/admin/login', gate: '/gate/login' };

export function isStaffPortal(value: unknown): value is StaffPortal {
  return value === 'admin' || value === 'gate';
}

export function verifiedClerkEmail(clerkUser: {
  primaryEmailAddress?: { emailAddress?: string | null; verification?: { status?: string | null } | null } | null;
  emailAddresses: { emailAddress?: string | null; verification?: { status?: string | null } | null }[];
}) {
  const primary = clerkUser.primaryEmailAddress;
  if (primary?.emailAddress && primary.verification?.status === 'verified') return primary.emailAddress;
  return clerkUser.emailAddresses.find((entry) => entry.verification?.status === 'verified')?.emailAddress ?? null;
}

export const MOBILE_UNAVAILABLE = 'Sign-in with a mobile number is not available yet. Please use your email address.';

/** Refuses every customer mobile flow while mobile features are off (env.ts mobileFeaturesEnabled). */
export function assertMobileAvailable() {
  if (mobileFeaturesEnabled()) return;
  const problems = mobileConfigurationProblems();
  if (problems.length) console.error('[config] mobile features switched on but unusable; missing or invalid:', problems.join('; '));
  throw new AppError(400, MOBILE_UNAVAILABLE, 'MOBILE_DISABLED');
}

export async function requestOtp(raw: string, ip: string) {
  assertLiveConfiguration();
  let contact: string;
  try {
    contact = normalizeContact(raw);
  } catch (error) {
    throw new AppError(400, (error as Error).message);
  }
  // Mobile sign-in only while MOBILE_PHONE_NUMBER_ENABLED is on and MSG91 is configured.
  // Same answer for every number (no account enumeration); nothing stored, nothing sent.
  if (!contact.includes('@')) assertMobileAvailable();
  await rateLimit('otp-ip:' + hash(ip), 30, 3600);
  await rateLimit('otp-contact:' + keyedHash(contact), 5, 3600);
  const code = String(randomInt(100000, 1000000));
  const challenge = await transaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['otp:' + contact]);
    const recent = await one(c, "SELECT 1 FROM otp_challenges WHERE contact=$1 AND created_at>now()-interval '30 seconds'", [contact]);
    requireValue(!recent, 'Please wait 30 seconds before requesting another code.', 429);
    await c.query('UPDATE otp_challenges SET used=true WHERE contact=$1', [contact]);
    return (await one(c, "INSERT INTO otp_challenges(contact,digest,expires_at) VALUES($1,$2,now()+interval '5 minutes') RETURNING id", [contact, keyedHash(contact + ':' + code)]))!;
  });
  const sms = !contact.includes('@');
  const body = sms
    ? `Samatat Sanskriti code: ${code}. Valid 5 min. Do not share.`
    : `Your code is ${code}. It expires in 5 minutes. Do not share it.`;
  await sendCode(contact, code, 'Your Samatat Sanskriti sign-in code', body, challenge.id);
  return {
    challengeId: challenge.id,
    message: sms ? 'If the number can receive SMS, your code is on its way.' : 'If delivery is available, your code is on its way.',
    ...(developmentAdaptersAllowed() && otpProvider() === 'development' ? { developmentCode: code } : {}),
  };
}

export async function verifyOtp(challengeId: string, code: string) {
  const result = await transaction(async (c) => {
    const challenge = await one(c, 'SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [challengeId]);
    if (!challenge || challenge.used || new Date(challenge.expires_at).getTime() < Date.now() || challenge.attempts >= 5) {
      return { error: 'This code has expired or is no longer valid.' };
    }
    // A mobile code issued before mobile features were switched off cannot sign anyone in.
    if (!String(challenge.contact).includes('@') && !mobileFeaturesEnabled()) return { error: MOBILE_UNAVAILABLE };
    await c.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challengeId]);
    if (!safeEqual(challenge.digest, keyedHash(challenge.contact + ':' + code))) return { error: 'The code is incorrect. Please try again.' };
    // A mobile already verified on an email account signs in to THAT account (no duplicate
    // account). verified_mobile is unique and stored only after its own code was proven.
    let user = await one<User>(c, 'SELECT * FROM users WHERE contact=$1 OR verified_mobile=$1 ORDER BY (contact=$1) DESC LIMIT 1 FOR UPDATE', [challenge.contact]);
    // Staff accounts sign in with their password at /admin/login or /gate/login only:
    // a customer code must never become a password-less staff login.
    if (user && user.role !== 'customer') {
      await audit(c, user.id, 'auth.otp.staff_refused', user.id);
      return { error: 'Staff accounts sign in with email and password at /admin/login or /gate/login.' };
    }
    await c.query('UPDATE otp_challenges SET used=true WHERE id=$1', [challengeId]);
    if (!user) user = (await one<User>(c, 'INSERT INTO users(contact) VALUES($1) RETURNING *', [challenge.contact]))!;
    const sessionToken = token();
    await c.query("INSERT INTO sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hash(sessionToken), user.id]);
    await audit(c, user.id, 'auth.login', user.id);
    return { sessionToken, user: { id: user.id, contact: user.contact, name: user.name, role: user.role } };
  });
  if ('error' in result) throw new AppError(400, result.error!);
  return result;
}

/** Email/username + password for staff/admin dashboard access. */
/**
 * THE staff authentication (both doors): email or username + password, the
 * existing scrypt hash, rate limits, then the door's role check, then the same
 * hashed-token session as every other login. No second factor.
 */
export async function loginStaff(identifier: string, password: string, portal: StaffPortal, ip = '') {
  // Staff access depends on core settings only, never on customer-sales readiness.
  assertStaffConfiguration();
  requireValue(isStaffPortal(portal), 'Choose the admin or gate sign-in page.', 400);
  const raw = identifier.trim();
  requireValue(raw.length > 0 && password.length >= 8, 'Enter your email (or username) and password (min 8 characters).', 400);
  await rateLimit('password-ip:' + hash(ip || 'unknown'), 20, 3600);
  await rateLimit('password-account:' + hash(raw.toLowerCase()), 100, 3600);

  const result = await transaction(async (c) => {
    const user = await one<User & { password_hash: string | null; username: string | null }>(
      c,
      'SELECT * FROM users WHERE lower(contact)=lower($1) OR lower(coalesce(username,\'\'))=lower($1) FOR UPDATE',
      [raw],
    );
    if (!user || !user.password_hash) return { error: 'Incorrect email or password.' };
    if (!verifyPassword(password, user.password_hash)) {
      await audit(c, user.id, 'auth.password.failed', user.id);
      return { error: 'Incorrect email or password.' };
    }
    if (user.role === 'customer') return { error: 'This account is not a staff account.' };
    if (!PORTAL_ROLES[portal].includes(user.role)) {
      await audit(c, user.id, 'auth.password.wrong_portal', user.id, { portal });
      const other: StaffPortal = portal === 'admin' ? 'gate' : 'admin';
      return { error: other === 'gate' ? 'Gate staff sign in at /gate/login.' : 'Admin staff sign in at /admin/login.', redirect: PORTAL_LOGIN[other] };
    }
    const sessionToken = token();
    await c.query("INSERT INTO sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hash(sessionToken), user.id]);
    await audit(c, user.id, 'auth.password', user.id, { portal });
    return { sessionToken, user: { id: user.id, contact: user.contact, name: user.name, role: user.role } };
  });
  if ('error' in result) throw new AppError(result.redirect ? 403 : 401, result.error!, result.redirect ? 'WRONG_PORTAL' : 'INVALID_REQUEST');
  return result;
}

/** Create or update a password-capable staff owner (used by seed / setup). */
export async function upsertStaffPassword(contact: string, password: string, name = 'Festival owner', username?: string) {
  const normalized = normalizeContact(contact);
  requireValue(password.length >= 8, 'Password must be at least 8 characters.', 400);
  const passwordHash = hashPassword(password);
  return transaction(async (c) => {
    let user = await one<User>(c, 'SELECT id, contact, name, role FROM users WHERE contact=$1 FOR UPDATE', [normalized]);
    if (user) {
      await c.query(
        `UPDATE users SET password_hash=$1, name=CASE WHEN $2<>'' THEN $2 ELSE name END, role='owner',
         username=COALESCE($3, username) WHERE id=$4`,
        [passwordHash, name, username ?? null, user.id],
      );
    } else {
      user = (await one<User>(
        c,
        `INSERT INTO users(contact, name, role, password_hash, username) VALUES($1,$2,'owner',$3,$4)
         RETURNING id, contact, name, role`,
        [normalized, name, passwordHash, username ?? null],
      ))!;
    }
    return user;
  });
}

export async function ensureUserFromClerk(clerkId: string, email: string, name = ''): Promise<User> {
  const contact = normalizeContact(email);
  return transaction(async (c) => {
    let user = await one<User>(c, 'SELECT id, contact, name, role FROM users WHERE clerk_id=$1', [clerkId]);
    if (user) {
      if (user.role !== 'customer') throw new AppError(403, 'Staff accounts must sign in with email and password.');
      if (name && !user.name) await c.query('UPDATE users SET name=$1 WHERE id=$2', [name, user.id]);
      return (await one<User>(c, 'SELECT id, contact, name, role FROM users WHERE id=$1', [user.id]))!;
    }
    user = await one<User>(c, 'SELECT id, contact, name, role FROM users WHERE contact=$1 FOR UPDATE', [contact]);
    if (user) {
      if (user.role !== 'customer') throw new AppError(403, 'Staff accounts must sign in with email and password.');
      await c.query("UPDATE users SET clerk_id=$1, name=CASE WHEN name='' AND $2<>'' THEN $2 ELSE name END WHERE id=$3", [clerkId, name, user.id]);
      await audit(c, user.id, 'auth.clerk.link', user.id, { clerkId });
      return (await one<User>(c, 'SELECT id, contact, name, role FROM users WHERE id=$1', [user.id]))!;
    }
    user = (await one<User>(c, 'INSERT INTO users(contact, name, clerk_id) VALUES($1,$2,$3) RETURNING id, contact, name, role', [contact, name, clerkId]))!;
    await audit(c, user.id, 'auth.clerk.create', user.id, { clerkId });
    return user;
  });
}

async function userFromClerkSession(): Promise<User | null> {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return null;
  try {
    const session = await auth();
    if (!session.userId) return null;
    const clerkUser = await clerkCurrentUser();
    if (!clerkUser) return null;
    const email = verifiedClerkEmail(clerkUser);
    if (!email) return null;
    const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ').trim();
    return ensureUserFromClerk(clerkUser.id, email, name);
  } catch {
    return null;
  }
}

/** Session token from the Authorization bearer header, else the session cookie. */
export async function presentedSessionToken(): Promise<string> {
  const authorization = (await headers()).get('authorization') ?? '';
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  return bearer || (await cookies()).get('festival_session')?.value || '';
}

/** The unexpired, unrevoked session's user. Revoked sessions are deleted rows. */
export async function sessionUser(sessionToken: string): Promise<User | null> {
  if (!sessionToken) return null;
  const rows = await query<User>(
    'SELECT u.id,u.contact,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=$1 AND s.expires_at>now()',
    [hash(sessionToken)],
  );
  return rows[0] ?? null;
}

export async function revokeSession(sessionToken: string) {
  if (sessionToken) await query('DELETE FROM sessions WHERE digest=$1', [hash(sessionToken)]);
}

export async function revokeUserSessions(c: Client, userId: string) {
  await c.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
}

export async function currentUser(): Promise<User | null> {
  const value = await presentedSessionToken();
  const row = await sessionUser(value);
  if (row) return row;
  return userFromClerkSession();
}

/** Server-side role check (the owner passes every check). */
export function assertRole(user: User, roles?: readonly Role[]) {
  if (roles && user.role !== 'owner' && !roles.includes(user.role)) throw new AppError(403, 'You do not have permission for this action.');
}

export async function authenticated(roles?: readonly Role[]): Promise<User> {
  const user = await currentUser();
  if (!user) throw new AppError(401, 'Please sign in to continue.');
  assertRole(user, roles);
  return user;
}
