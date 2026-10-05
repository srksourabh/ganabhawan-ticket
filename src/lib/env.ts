import { AppError } from './errors';

/**
 * Two runtime modes. Anything other than an explicit APP_MODE=development is
 * live, so a missing or misspelled value can never unlock development adapters.
 */
export type AppMode = 'development' | 'live';
export const appMode = (): AppMode => (process.env.APP_MODE === 'development' ? 'development' : 'live');
export const devMode = () => appMode() === 'development';

/** Deployment label for live mode: staging uses Razorpay test keys, production live keys. */
export type DeployEnv = 'staging' | 'production';
export function deployEnv(): DeployEnv | null {
  const value = (process.env.DEPLOY_ENV ?? '').trim().toLowerCase();
  return value === 'staging' || value === 'production' ? value : null;
}

/** True only for an APP_URL that explicitly names a loopback host. Unset is NOT local. */
export function isLocalAppUrl(raw = process.env.APP_URL ?? ''): boolean {
  const value = raw.trim();
  if (!value) return false;
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/** Cloudflare Workers identify themselves; dev adapters are never allowed there. */
export function onWorkersRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

/**
 * The single switch for every development shortcut (OTP code in responses,
 * staff MFA skip, free dev payments, sales-switch bypass, silent delivery).
 * All three conditions must hold; each one alone fails closed.
 */
export function developmentAdaptersAllowed(): boolean {
  return devMode() && isLocalAppUrl() && !onWorkersRuntime();
}

/** Development payment adapter only when Razorpay is not selected. */
export function usingDevelopmentPayments() {
  return process.env.PAYMENT_PROVIDER !== 'razorpay';
}

export function secret(name: string) {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters. Run npm run setup locally.`);
  return value;
}

const present = (name: string) => Boolean(process.env[name]?.trim());
const long = (name: string, min: number) => (process.env[name]?.trim().length ?? 0) >= min;

/**
 * Names (never values) of everything that makes this runtime unsafe to serve.
 * Empty list = safe. Used by the proxy, /api/health and every money/auth path.
 */
export function configurationProblems(): string[] {
  const problems: string[] = [];
  if (devMode()) {
    if (!developmentAdaptersAllowed()) {
      problems.push('APP_MODE=development requires a localhost APP_URL and is refused on Cloudflare Workers');
    }
    return problems;
  }

  if (!present('DATABASE_URL')) problems.push('DATABASE_URL');
  if (!long('SESSION_SECRET', 32)) problems.push('SESSION_SECRET (32+ chars)');
  if (!long('CREDENTIAL_KEY', 32)) problems.push('CREDENTIAL_KEY (32+ chars)');
  if (!long('CRON_SECRET', 16)) problems.push('CRON_SECRET (16+ chars)');

  const appUrl = process.env.APP_URL?.trim() ?? '';
  if (!appUrl.startsWith('https://') || isLocalAppUrl(appUrl)) problems.push('APP_URL (public https URL)');

  const env = deployEnv();
  if (!env) problems.push('DEPLOY_ENV (staging or production)');

  if (process.env.PAYMENT_PROVIDER !== 'razorpay') problems.push('PAYMENT_PROVIDER=razorpay');
  for (const name of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
    if (!present(name)) problems.push(name);
  }
  const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? '';
  if (keyId && env === 'production' && !keyId.startsWith('rzp_live_')) problems.push('RAZORPAY_KEY_ID (production needs a live key)');
  if (keyId && env === 'staging' && !keyId.startsWith('rzp_test_')) problems.push('RAZORPAY_KEY_ID (staging needs a test key)');

  const otp = (process.env.OTP_PROVIDER || 'development').trim().toLowerCase();
  if (otp === 'development') problems.push('OTP_PROVIDER (real provider)');
  if (otp === 'httpsms' && !(present('HTTPSMS_API_KEY') && present('HTTPSMS_FROM'))) problems.push('HTTPSMS_API_KEY/HTTPSMS_FROM');

  const resend = present('RESEND_API_KEY') && present('EMAIL_FROM');
  const composio = present('COMPOSIO_API_KEY') && (present('COMPOSIO_CONNECTED_ACCOUNT_ID') || present('COMPOSIO_USER_ID'));
  if (!resend && !composio) problems.push('email delivery (RESEND_API_KEY+EMAIL_FROM or Composio)');

  if (present('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY') && !present('CLERK_SECRET_KEY')) problems.push('CLERK_SECRET_KEY');
  return problems;
}

/** Fail closed: refuse the request with a generic 503; log names only. */
export function assertLiveConfiguration() {
  const problems = configurationProblems();
  if (problems.length === 0) return;
  console.error('[config] refusing to serve; missing or unsafe:', problems.join('; '));
  throw new AppError(503, 'This service is not configured for sales yet. Please try again later.', 'CONFIG_INVALID');
}
