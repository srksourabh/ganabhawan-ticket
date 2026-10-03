import type { NextConfig } from 'next';

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  process.env.NODE_ENV === 'development' ? "'unsafe-eval'" : '',
  'https://checkout.razorpay.com',
  'https://*.clerk.accounts.dev',
  'https://*.clerk.com',
].filter(Boolean).join(' ');

const config: NextConfig = {
  serverExternalPackages: ['pg'],
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      { key: 'Content-Security-Policy', value: [
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
      ].join('; ') },
    ] }];
  },
};
export default config;
