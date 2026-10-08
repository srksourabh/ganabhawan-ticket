import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { secret } from './env';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const keyedHash = (value: string) => createHmac('sha256', secret('SESSION_SECRET')).update(value).digest('hex');
export function safeEqual(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  const check = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return check.length === expected.length && timingSafeEqual(check, expected);
}
export function encrypt(value: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(hash(secret('CREDENTIAL_KEY')), 'hex'), iv);
  return [iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()].map(x => x.toString('base64url')).join('.');
}
export function decrypt(value: string) {
  const [iv, body, final, tag] = value.split('.').map(x => Buffer.from(x, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hash(secret('CREDENTIAL_KEY')), 'hex'), iv);
  decipher.setAuthTag(tag); return Buffer.concat([decipher.update(body), decipher.update(final), decipher.final()]).toString('utf8');
}
export function normalizeContact(value: string) {
  const raw = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return raw.toLowerCase();
  let phone = raw.replace(/[\s()-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (/^0[6-9]\d{9}$/.test(phone)) phone = `+91${phone.slice(1)}`;
  else if (/^[6-9]\d{9}$/.test(phone)) phone = `+91${phone}`;
  else if (/^91[6-9]\d{9}$/.test(phone)) phone = `+${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Enter a valid email or mobile number with country code, for example +91.');
  return phone;
}
export function maskContact(value: string) { return value.includes('@') ? value.slice(0, 2) + '***@' + value.split('@')[1] : value.slice(0, 3) + '••••••' + value.slice(-3); }
