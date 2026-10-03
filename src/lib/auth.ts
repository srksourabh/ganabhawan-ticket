import { randomInt } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { auth, currentUser as clerkCurrentUser } from '@clerk/nextjs/server';
import { query, transaction, one } from './db';
import { assertLiveConfiguration, devMode, isLocalAppUrl } from './env';
import { keyedHash, normalizeContact, token, hash, safeEqual, decrypt, totpValid, hashPassword, verifyPassword } from './security';
import { AppError, requireValue } from './errors';
import type { User, Role } from './types';
import { audit } from './audit';
import { httpsmsEnabled, otpProvider, sendHttpsmsMessage } from './httpsms';
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

export async function sendMessage(contact: string, subject: string, message: string, requestId?: string) {
  const phone = !contact.includes('@');
  const viaHttpsms = phone && httpsmsEnabled();
  const viaComposio = !phone && composioGmailConfigured();
  if (devMode() && otpProvider() === 'development' && !viaHttpsms && !viaComposio) return;

  if (!phone) {
    if (viaComposio) {
      await sendComposioGmail(contact, subject, message);
      return;
    }
    requireValue(process.env.RESEND_API_KEY && process.env.EMAIL_FROM, 'Email delivery is not configured.', 503);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [contact], subject, text: message }),
      signal: AbortSignal.timeout(10000),
    });
    requireValue(response.ok, 'Email delivery is temporarily unavailable.', 503);
    return;
  }

  if (viaHttpsms) {
    await sendHttpsmsMessage(contact, message, requestId);
    return;
  }

  requireValue(process.env.SMS_API_URL && process.env.SMS_API_TOKEN, 'SMS delivery is not configured. Please use email.', 503);
  const response = await fetch(process.env.SMS_API_URL!, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.SMS_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: contact, message }),
    signal: AbortSignal.timeout(10000),
  });
  requireValue(response.ok, 'SMS delivery is temporarily unavailable.', 503);
}

function staffMfaRequired() {
  return !(devMode() && isLocalAppUrl());
}

export function verifiedClerkEmail(clerkUser: {
  primaryEmailAddress?: { emailAddress?: string | null; verification?: { status?: string | null } | null } | null;
  emailAddresses: { emailAddress?: string | null; verification?: { status?: string | null } | null }[];
}) {
  const primary = clerkUser.primaryEmailAddress;
  if (primary?.emailAddress && primary.verification?.status === 'verified') return primary.emailAddress;
  return clerkUser.emailAddresses.find((entry) => entry.verification?.status === 'verified')?.emailAddress ?? null;
}

export async function requestOtp(raw: string, ip: string) {
  assertLiveConfiguration();
  let contact: string;
  try {
    contact = normalizeContact(raw);
  } catch (error) {
    throw new AppError(400, (error as Error).message);
  }
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
  await sendMessage(contact, 'Your Samatat Sanskriti sign-in code', body, challenge.id);
  return {
    challengeId: challenge.id,
    message: sms ? 'If the number can receive SMS, your code is on its way.' : 'If delivery is available, your code is on its way.',
    ...(devMode() && isLocalAppUrl() && otpProvider() === 'development' ? { developmentCode: code } : {}),
  };
}

export async function verifyOtp(challengeId: string, code: string, mfaCode = '') {
  const result = await transaction(async (c) => {
    const challenge = await one(c, 'SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [challengeId]);
    if (!challenge || challenge.used || new Date(challenge.expires_at).getTime() < Date.now() || challenge.attempts >= 5) {
      return { error: 'This code has expired or is no longer valid.' };
    }
    await c.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challengeId]);
    if (!safeEqual(challenge.digest, keyedHash(challenge.contact + ':' + code))) return { error: 'The code is incorrect. Please try again.' };
    let user = await one<User>(c, 'SELECT * FROM users WHERE contact=$1', [challenge.contact]);
    if (user && user.role !== 'customer' && staffMfaRequired()) {
      if (!user.mfa_secret || !totpValid(decrypt(user.mfa_secret), mfaCode)) return { error: 'A valid staff authenticator code is required.' };
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
export async function loginWithPassword(identifier: string, password: string, mfaCode = '', ip = '') {
  assertLiveConfiguration();
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
    if (!verifyPassword(password, user.password_hash)) return { error: 'Incorrect email or password.' };
    if (user.role === 'customer') return { error: 'This account cannot access the admin dashboard.' };
    if (staffMfaRequired()) {
      if (!user.mfa_secret || !totpValid(decrypt(user.mfa_secret), mfaCode)) return { error: 'A valid staff authenticator code is required.' };
    }
    const sessionToken = token();
    await c.query("INSERT INTO sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hash(sessionToken), user.id]);
    await audit(c, user.id, 'auth.password', user.id);
    return { sessionToken, user: { id: user.id, contact: user.contact, name: user.name, role: user.role } };
  });
  if ('error' in result) throw new AppError(401, result.error!);
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
      if (user.role !== 'customer') throw new AppError(403, 'Staff accounts must sign in with a password and authenticator.');
      if (name && !user.name) await c.query('UPDATE users SET name=$1 WHERE id=$2', [name, user.id]);
      return (await one<User>(c, 'SELECT id, contact, name, role FROM users WHERE id=$1', [user.id]))!;
    }
    user = await one<User>(c, 'SELECT id, contact, name, role FROM users WHERE contact=$1 FOR UPDATE', [contact]);
    if (user) {
      if (user.role !== 'customer') throw new AppError(403, 'Staff accounts must sign in with a password and authenticator.');
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

export async function currentUser(): Promise<User | null> {
  const authorization = (await headers()).get('authorization') ?? '';
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const value = bearer || (await cookies()).get('festival_session')?.value;
  if (value) {
    const row = (
      await query<User>(
        'SELECT u.id,u.contact,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=$1 AND s.expires_at>now()',
        [hash(value)],
      )
    )[0];
    if (row) return row;
  }
  return userFromClerkSession();
}

export async function authenticated(roles?: Role[]): Promise<User> {
  const user = await currentUser();
  if (!user) throw new AppError(401, 'Please sign in to continue.');
  if (roles && user.role !== 'owner' && !roles.includes(user.role)) throw new AppError(403, 'You do not have permission for this action.');
  return user;
}
