export const devMode = () => process.env.APP_MODE === 'development';

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
  if (devMode()) return;
  secret('SESSION_SECRET'); secret('CREDENTIAL_KEY');
  if (process.env.PAYMENT_PROVIDER !== 'razorpay' || process.env.OTP_PROVIDER === 'development') throw new Error('Live mode requires real payment and delivery providers.');
  if (process.env.OTP_PROVIDER === 'httpsms') {
    if (!process.env.HTTPSMS_API_KEY || !process.env.HTTPSMS_FROM) throw new Error('Live httpSMS OTP requires HTTPSMS_API_KEY and HTTPSMS_FROM.');
  }
  if (!process.env.RESEND_API_KEY && !process.env.COMPOSIO_API_KEY) {
    throw new Error('Live mode requires Resend or Composio Gmail for email OTP.');
  }
}
