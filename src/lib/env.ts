import { AppError } from './errors';

export const devMode = () => process.env.APP_MODE === 'development';

/** Unset APP_URL is local setup. A public URL must not run development adapters. */
export function isLocalAppUrl(raw = process.env.APP_URL ?? ''): boolean {
  const value = raw.trim();
  if (!value) return true;
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
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
export function assertLiveConfiguration() {
  if (!isLocalAppUrl() && (devMode() || usingDevelopmentPayments() || process.env.OTP_PROVIDER === 'development')) {
    throw new AppError(503, 'Development adapters cannot run on a public host. Set APP_MODE=live and real payment and OTP providers.');
  }
  if (devMode()) return;
  secret('SESSION_SECRET'); secret('CREDENTIAL_KEY');
  if (process.env.PAYMENT_PROVIDER !== 'razorpay' || process.env.OTP_PROVIDER === 'development') throw new Error('Live mode requires real payment and delivery providers.');
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) throw new Error('Live mode requires RAZORPAY_WEBHOOK_SECRET.');
  if (process.env.OTP_PROVIDER === 'httpsms') {
    if (!process.env.HTTPSMS_API_KEY || !process.env.HTTPSMS_FROM) throw new Error('Live httpSMS OTP requires HTTPSMS_API_KEY and HTTPSMS_FROM.');
  }
  if (!process.env.RESEND_API_KEY && !process.env.COMPOSIO_API_KEY) {
    throw new Error('Live mode requires Resend or Composio Gmail for email OTP.');
  }
}
