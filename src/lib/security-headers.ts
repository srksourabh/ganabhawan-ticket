/** Browser security headers applied in proxy (Workers) and next.config (Node). */
const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  process.env.NODE_ENV === 'development' ? "'unsafe-eval'" : '',
  'https://checkout.razorpay.com',
  'https://*.clerk.accounts.dev',
  'https://*.clerk.com',
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
      "form-action 'self'",
      "frame-ancestors 'none'",
      `script-src ${scriptSrc}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://*.clerk.accounts.dev https://*.clerk.com https://clerk-telemetry.com",
      "frame-src https://api.razorpay.com https://checkout.razorpay.com https://*.clerk.accounts.dev https://*.clerk.com",
    ].join('; '),
  },
];

export function applySecurityHeaders(headers: Headers) {
  for (const { key, value } of SECURITY_HEADER_LIST) headers.set(key, value);
}
