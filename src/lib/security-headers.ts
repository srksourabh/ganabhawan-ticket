/** Browser security headers applied in proxy (Workers) and next.config (Node). */

/**
 * Clerk publishable keys encode the instance's Frontend API host
 * (pk_live_<base64("clerk.example.org$")>). Production instances serve from
 * the customer's own domain, so it must be allowed explicitly.
 */
export function clerkFrontendHost(publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''): string | null {
  const match = /^pk_(?:live|test)_(.+)$/.exec(publishableKey.trim());
  if (!match) return null;
  try {
    const host = Buffer.from(match[1], 'base64').toString('utf8').replace(/\$$/, '');
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

const clerkHost = clerkFrontendHost();
const clerk = ['https://*.clerk.accounts.dev', 'https://*.clerk.com', clerkHost ? `https://${clerkHost}` : ''].filter(Boolean).join(' ');
const turnstile = 'https://challenges.cloudflare.com';

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  process.env.NODE_ENV === 'development' ? "'unsafe-eval'" : '',
  'https://checkout.razorpay.com',
  clerk,
  turnstile,
].filter(Boolean).join(' ');

export const SECURITY_HEADER_LIST: { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      `form-action 'self' ${clerk} https://accounts.google.com`,
      "frame-ancestors 'none'",
      `script-src ${scriptSrc}`,
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      `connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com ${clerk} https://clerk-telemetry.com https://accounts.google.com https://*.googleapis.com`,
      `frame-src https://api.razorpay.com https://checkout.razorpay.com ${clerk} ${turnstile} https://accounts.google.com https://*.google.com`,
    ].join('; '),
  },
];

export function applySecurityHeaders(headers: Headers) {
  for (const { key, value } of SECURITY_HEADER_LIST) headers.set(key, value);
}
