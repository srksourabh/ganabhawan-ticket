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

/** True only when DATABASE_URL points at this machine (embedded/local Postgres). */
export function isLoopbackDatabase(raw = process.env.DATABASE_URL ?? ''): boolean {
  try {
    const host = new URL(raw).hostname;
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
 * free dev payments, sales-switch bypass, silent delivery).
 * All four conditions must hold; each one alone fails closed. The database
 * condition stops a laptop with a development .env.local from acting on a
 * shared (staging/production) database, e.g. a CLI "refunding" for free.
 */
export function developmentAdaptersAllowed(): boolean {
  return devMode() && isLocalAppUrl() && isLoopbackDatabase() && !onWorkersRuntime();
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

/** "otp@samatat.org" or "Samatat <otp@samatat.org>": one address, no spaces or angle brackets inside it. */
export function isEmailSender(value: string): boolean {
  const address = /^[^<>]*<([^<>]+)>$/.exec(value.trim())?.[1] ?? value.trim();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(address);
}

const present = (name: string) => Boolean(process.env[name]?.trim());
const long = (name: string, min: number) => (process.env[name]?.trim().length ?? 0) >= min;

/**
 * Names (never values) of everything that makes this runtime unsafe to serve.
 * Empty list = safe. Used by the proxy, /api/health and every money/auth path.
 */
/**
 * Settings every live request needs, staff included: database, session and
 * encryption keys, the public URL, the deploy environment and Clerk (pages
 * cannot render without it), plus the development-mode safety rule.
 */
export function coreConfigurationProblems(): string[] {
  const problems: string[] = [];
  if (devMode()) {
    if (!developmentAdaptersAllowed()) {
      problems.push('APP_MODE=development requires a localhost APP_URL and a local DATABASE_URL, and is refused on Cloudflare Workers');
    }
    return problems;
  }
  if (!present('DATABASE_URL')) problems.push('DATABASE_URL');
  if (!long('SESSION_SECRET', 32)) problems.push('SESSION_SECRET (32+ chars)');
  if (!long('CREDENTIAL_KEY', 32)) problems.push('CREDENTIAL_KEY (32+ chars)');
  const appUrl = process.env.APP_URL?.trim() ?? '';
  if (!appUrl.startsWith('https://') || isLocalAppUrl(appUrl)) problems.push('APP_URL (public https URL)');
  if (!deployEnv()) problems.push('DEPLOY_ENV (staging or production)');
  // clerkMiddleware (proxy.ts) and ClerkProvider cannot render any page without both keys.
  if (!present('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')) problems.push('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  if (!present('CLERK_SECRET_KEY')) problems.push('CLERK_SECRET_KEY');
  return problems;
}

/**
 * Settings only CUSTOMER SALES need: payments (paymentConfigurationProblems) plus everything
 * customers need even without buying (customerConfigurationProblems: sign-in codes, email, Clerk,
 * the background worker). Missing ones block every customer purchase path, never staff
 * administration. Payment problems alone do not stop sign-in, accounts or tickets (config-gate.ts).
 */
export function salesConfigurationProblems(): string[] {
  return [...paymentConfigurationProblems(), ...customerConfigurationProblems()];
}

/** Razorpay's environment: test (no real money) or live. */
export type PaymentMode = 'test' | 'live';

/** The environment a Razorpay key id belongs to (rzp_test_… / rzp_live_…), or null when it is not one. */
export function razorpayKeyMode(keyId = process.env.RAZORPAY_KEY_ID): PaymentMode | null {
  return (/^rzp_(test|live)_/.exec(keyId?.trim() ?? '')?.[1] as PaymentMode | undefined) ?? null;
}

/**
 * The Razorpay environment this server uses, from trusted server settings only (never a request):
 * RAZORPAY_MODE ("test" or "live") when set, else the configured key id's own prefix. Switching
 * modes = replacing RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET (and
 * RAZORPAY_MODE when set) in the Worker settings; no code, rebuild or data change.
 */
export function paymentMode(): PaymentMode | null {
  const explicit = (process.env.RAZORPAY_MODE ?? '').trim().toLowerCase();
  if (explicit === 'test' || explicit === 'live') return explicit;
  return razorpayKeyMode();
}

/**
 * Razorpay settings for taking payments, valid in either environment: test keys (rzp_test_…,
 * no real money) or live keys (rzp_live_…). RAZORPAY_MODE, when set, is an interlock: a key from
 * the other environment is refused. Staging never takes real money (test keys only). The key
 * secret and webhook secret cannot be checked locally; they must come from the same Razorpay
 * environment as the key id (a mismatch fails at the provider, never succeeds).
 */
export function paymentConfigurationProblems(env = deployEnv()): string[] {
  const problems: string[] = [];
  if (devMode()) return problems; // development mode is judged entirely by coreConfigurationProblems
  if (process.env.PAYMENT_PROVIDER !== 'razorpay') problems.push('PAYMENT_PROVIDER=razorpay');
  for (const name of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
    if (!present(name)) problems.push(name);
  }
  const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? '';
  const keyMode = razorpayKeyMode(keyId);
  const explicitRaw = (process.env.RAZORPAY_MODE ?? '').trim().toLowerCase();
  const explicit = explicitRaw === 'test' || explicitRaw === 'live' ? explicitRaw : null;
  if (explicitRaw && !explicit) problems.push('RAZORPAY_MODE ("test" or "live")');
  if (keyId && !keyMode) problems.push('RAZORPAY_KEY_ID (a Razorpay key id: rzp_test_… or rzp_live_…)');
  if (keyMode && explicit && keyMode !== explicit) problems.push(`RAZORPAY_KEY_ID (RAZORPAY_MODE=${explicit} needs an rzp_${explicit}_ key)`);
  if (keyMode === 'live' && env === 'staging') problems.push('RAZORPAY_KEY_ID (staging needs a test key)');
  return problems;
}

/**
 * Everything customers need besides payments: sign-in codes, email delivery and senders, Clerk
 * (Google sign-in) and the background worker that sends confirmations and settles payments.
 * Missing ones stop customer sign-in and purchases; staff administration is unaffected.
 */
export function customerConfigurationProblems(): string[] {
  const problems: string[] = [];
  if (devMode()) return problems; // development mode is judged entirely by coreConfigurationProblems
  if (!long('CRON_SECRET', 16)) problems.push('CRON_SECRET (16+ chars)');
  const env = deployEnv();

  problems.push(...clerkInstanceProblems(env));

  const otp = (process.env.OTP_PROVIDER || 'development').trim().toLowerCase();
  if (otp === 'development') problems.push('OTP_PROVIDER (real provider)');
  if (otp === 'httpsms') problems.push('OTP_PROVIDER (httpSMS is not used in live mode; mobile codes go through MSG91)');
  // MSG91 is NOT a sales requirement: with MOBILE_PHONE_NUMBER_ENABLED off (the default) customers
  // sign in, buy and are confirmed by email only. Mobile settings: mobileConfigurationProblems.

  const resend = present('RESEND_API_KEY') && present('EMAIL_FROM');
  const composio = present('COMPOSIO_API_KEY') && (present('COMPOSIO_CONNECTED_ACCOUNT_ID') || present('COMPOSIO_USER_ID'));
  if (!resend && !composio) problems.push('email delivery (RESEND_API_KEY+EMAIL_FROM or Composio)');
  // The default sender of every email (Resend needs it; Composio Gmail may omit it): one valid address when set.
  const emailFrom = process.env.EMAIL_FROM?.trim();
  if (emailFrom && !isEmailSender(emailFrom)) problems.push('EMAIL_FROM (an address such as tickets@samatat.org, or "Name <tickets@samatat.org>")');
  // Optional sender for sign-in code emails (auth.ts otpEmailSender); EMAIL_FROM when unset.
  const otpFrom = process.env.OTP_FROM_EMAIL?.trim();
  if (otpFrom && !isEmailSender(otpFrom)) problems.push('OTP_FROM_EMAIL (an address such as otp@samatat.org, or "Name <otp@samatat.org>")');
  return problems;
}

/**
 * Customer Google sign-in goes through Clerk. A Clerk development instance (pk_test_/sk_test_)
 * shows Clerk's "Development mode" badge, caps its users and signs in with Clerk's shared Google
 * credentials, so production needs a production instance (pk_live_/sk_live_), like Razorpay's
 * live key. The two keys must also come from the same kind of instance.
 * The publishable key is read statically: the build inlines it, so this checks the exact key the
 * browser bundle uses (a Worker runtime secret of the same name does not change the bundle).
 * CLERK_DEVELOPMENT_INSTANCE_ALLOWED (temporary, off by default) relaxes only the
 * production-instance requirement; see clerkDevelopmentInstanceAllowed.
 */
export function clerkInstanceProblems(
  env = deployEnv(),
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  secretKey = process.env.CLERK_SECRET_KEY,
  allowDevelopment = clerkDevelopmentInstanceAllowed(),
): string[] {
  const kind = (key: string | undefined, prefix: 'pk' | 'sk') => new RegExp(`^${prefix}_(live|test)_`).exec(key?.trim() ?? '')?.[1] ?? null;
  const pk = kind(publishableKey, 'pk');
  const sk = kind(secretKey, 'sk');
  const problems: string[] = [];
  const strict = env === 'production' && !allowDevelopment;
  if (strict && publishableKey?.trim() && pk !== 'live') problems.push('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (production needs a Clerk production instance, pk_live_; rebuild after changing it)');
  if (strict && secretKey?.trim() && sk !== 'live') problems.push('CLERK_SECRET_KEY (production needs a Clerk production instance, sk_live_)');
  // Override on: development keys are accepted, but they must still be real Clerk keys.
  if (!strict && publishableKey?.trim() && !pk) problems.push('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (not a Clerk publishable key)');
  if (!strict && secretKey?.trim() && !sk) problems.push('CLERK_SECRET_KEY (not a Clerk secret key)');
  if (pk && sk && pk !== sk) problems.push('Clerk keys (publishable and secret key come from different kinds of Clerk instance)');
  return problems;
}

/**
 * CLERK_DEVELOPMENT_INSTANCE_ALLOWED: a TEMPORARY operator override that lets a production
 * deployment (DEPLOY_ENV=production) run customer Google sign-in on a Clerk DEVELOPMENT
 * instance (pk_test_/sk_test_) until the Clerk production instance exists. Exactly "true"
 * turns it on; unset or anything else keeps the strict pk_live_/sk_live_ rule. Server-side
 * only. It changes nothing else: Clerk still verifies every session, the secret key stays
 * server-side, staff still sign in with passwords, and every other sales requirement
 * (database, keys, Razorpay live key, email, ALLOW_PUBLIC_SALES) still applies.
 * Limitations of a development instance: Clerk shows a "Development mode" badge, it has a
 * user cap, it uses Clerk's shared Google OAuth credentials (Clerk's name on the consent
 * screen), and its session handshake goes through *.clerk.accounts.dev.
 */
export function clerkDevelopmentInstanceAllowed(): boolean {
  return (process.env.CLERK_DEVELOPMENT_INSTANCE_ALLOWED ?? '').trim().toLowerCase() === 'true';
}

/** The operator's global switch for NEW public purchases (ALLOW_PUBLIC_SALES exactly "true"; local development aside). */
export function publicSalesOpen(): boolean {
  return developmentAdaptersAllowed() || process.env.ALLOW_PUBLIC_SALES === 'true';
}

/** Customers can buy at all: every customer-sales setting valid AND public sales on (what purchases check). */
export function customerPurchasesOpen(): boolean {
  return configurationProblems().length === 0 && publicSalesOpen();
}

/**
 * SEASON_TICKET_SALES_ENABLED, the operator's switch for NEW season-ticket sales, separate
 * from ALLOW_PUBLIC_SALES (which it never overrides: a season sale needs both) and from each
 * product's "On sale". A runtime setting (Cloudflare Worker variable), not a database value:
 * exactly "true" (any case) opens season sales; unset or anything else keeps them CLOSED.
 * Existing season bookings, tickets, QR codes, admission and payments never depend on it.
 */
export function seasonTicketSalesEnabled(): boolean {
  return (process.env.SEASON_TICKET_SALES_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * CUSTOMER_OTP_ENABLED, the operator's switch for customer sign-in with a one-time code
 * (email, and mobile when mobile features are on). Temporarily OFF: customers sign in with
 * Google (Clerk). Server-side only, nothing from a request can change it; exactly "true"
 * (any case) turns it on, anything else (unset included) is off. Adding a mobile number to
 * an account (account-contacts.ts) is not sign-in and follows mobileFeaturesEnabled only.
 */
export function customerOtpEnabled(): boolean {
  return (process.env.CUSTOMER_OTP_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * MOBILE_PHONE_NUMBER_ENABLED, the operator's switch for customer mobile features
 * (mobile sign-in codes, mobile verification, every customer SMS). Server-side only:
 * nothing from a request can change it. "true" or "false"; unset = false; any other
 * value is malformed and counts as false.
 */
export function mobileFlag(): { on: boolean; malformed: boolean } {
  const value = (process.env.MOBILE_PHONE_NUMBER_ENABLED ?? '').trim().toLowerCase();
  if (value === '' || value === 'false') return { on: false, malformed: false };
  if (value === 'true') return { on: true, malformed: false };
  return { on: false, malformed: true };
}

/**
 * Why mobile features are off although the operator switched them on (names only).
 * Live mode needs MSG91 as the only SMS provider with its sign-in-code and
 * confirmation templates; local development may use its free-text gateways.
 */
export function mobileConfigurationProblems(): string[] {
  const flag = mobileFlag();
  if (flag.malformed) return ['MOBILE_PHONE_NUMBER_ENABLED (must be "true" or "false")'];
  if (!flag.on || developmentAdaptersAllowed()) return [];
  const problems: string[] = [];
  if ((process.env.SMS_PROVIDER || '').trim().toLowerCase() !== 'msg91') problems.push('SMS_PROVIDER=msg91');
  for (const name of ['MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID', 'MSG91_TEMPLATE_ID']) {
    if (!present(name)) problems.push(name);
  }
  return problems;
}

/** Mobile sign-in, mobile verification and SMS: switched on AND completely configured (fail closed). */
export function mobileFeaturesEnabled(): boolean {
  return mobileFlag().on && mobileConfigurationProblems().length === 0;
}

/** Everything needed to open customer sales (core + sales). */
export function configurationProblems(): string[] {
  return [...coreConfigurationProblems(), ...salesConfigurationProblems()];
}

/** Fail closed: refuse the request with a generic 503; log names only. */
/** Staff sign-in and administration: core settings only (never customer-sales settings). */
export function assertStaffConfiguration() {
  const problems = coreConfigurationProblems();
  if (problems.length === 0) return;
  console.error('[config] refusing staff access; missing or unsafe:', problems.join('; '));
  throw new AppError(503, 'This service is not configured yet. Please try again later.', 'CONFIG_INVALID');
}

/**
 * Customer sign-in codes and other customer services that take no payment: core and customer
 * settings, never the payment settings (a payment problem must not stop sign-in).
 */
export function assertCustomerConfiguration() {
  const problems = [...coreConfigurationProblems(), ...customerConfigurationProblems()];
  if (problems.length === 0) return;
  console.error('[config] refusing customer service; missing or unsafe:', problems.join('; '));
  throw new AppError(503, 'This service is not available yet. Please try again later.', 'CONFIG_INVALID');
}

/** Customer sales (holds, checkouts, payment orders): every setting. */
export function assertLiveConfiguration() {
  const problems = configurationProblems();
  if (problems.length === 0) return;
  console.error('[config] refusing to serve; missing or unsafe:', problems.join('; '));
  throw new AppError(503, 'This service is not configured for sales yet. Please try again later.', 'CONFIG_INVALID');
}
