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

/** True when OTP would be a no-op. A configured email or SMS sender is a real provider. */
export function usingDevelopmentDelivery() {
  const provider = (process.env.OTP_PROVIDER || 'development').trim().toLowerCase();
  if (provider !== 'development') return false;
  const composio = Boolean(
    process.env.COMPOSIO_API_KEY?.trim() &&
      (process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim() || process.env.COMPOSIO_USER_ID?.trim()),
  );
  const resend = Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());
  const httpsms = Boolean(process.env.HTTPSMS_API_KEY?.trim() && process.env.HTTPSMS_FROM?.trim());
  const sms = Boolean(process.env.SMS_API_URL?.trim() && process.env.SMS_API_TOKEN?.trim());
  return !(composio || resend || httpsms || sms);
}

export function secret(name: string) {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters. Run npm run setup locally.`);
  return value;
}
export function assertLiveConfiguration() {
  // Razorpay on a public host is allowed while APP_MODE=development (.env.example).
  // Only the fake payment adapter is refused. Delivery is checked on the OTP route.
  if (!isLocalAppUrl() && usingDevelopmentPayments()) {
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
