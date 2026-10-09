#!/usr/bin/env node
/**
 * Push local .env.local values into Wrangler secrets for ganabhawan-festival.
 * Usage: node scripts/push-cf-secrets.mjs
 * Requires: wrangler auth and a built dist/server/wrangler.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Usage: node scripts/push-cf-secrets.mjs [env-file]   e.g. .env.staging or .env.production
const envPath = resolve(process.argv[2] || '.env.local');
if (!existsSync(envPath)) {
  console.error(`Missing ${envPath}.`);
  process.exit(1);
}

const required = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'CREDENTIAL_KEY',
  'CRON_SECRET',
  'APP_MODE',
  'APP_URL',
  'DEPLOY_ENV',
  'PAYMENT_PROVIDER',
  'OTP_PROVIDER',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
];

const optional = [
  'ALLOW_PUBLIC_SALES',
  'CHROMA_URL',
  'CHROMA_COLLECTION',
  'OPS_MONITOR_TOKEN',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'COMPOSIO_API_KEY',
  'COMPOSIO_USER_ID',
  'COMPOSIO_CONNECTED_ACCOUNT_ID',
  'MOBILE_PHONE_NUMBER_ENABLED',
  'SMS_PROVIDER',
  'MSG91_AUTH_KEY',
  'MSG91_OTP_TEMPLATE_ID',
  'MSG91_OTP_VARIABLE',
  'MSG91_TEMPLATE_ID',
  'MSG91_SENDER_ID',
  'MSG91_TEMPLATE_VARIABLES',
  'MSG91_NOTICE_TEMPLATE_ID',
  'MSG91_NOTICE_TEMPLATE_VARIABLES',
  'NEXT_PUBLIC_CLERK_SIGN_IN_URL',
  'NEXT_PUBLIC_CLERK_SIGN_UP_URL',
  'NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL',
  'NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL',
];

const raw = readFileSync(envPath, 'utf8');
const values = Object.fromEntries(
  raw
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

// A deployed Worker is always live: refuse to push a development configuration.
if (values.APP_MODE !== 'live') {
  console.error('Refusing to deploy: APP_MODE must be "live" for a Cloudflare Worker (development adapters are refused there anyway).');
  process.exit(1);
}
if (!/^https:\/\//.test(values.APP_URL || '') || /localhost|127\.0\.0\.1/.test(values.APP_URL || '')) {
  console.error('Refusing to deploy: APP_URL must be the public https URL of this Worker.');
  process.exit(1);
}
if (!['staging', 'production'].includes(values.DEPLOY_ENV)) {
  console.error('Refusing to deploy: DEPLOY_ENV must be "staging" or "production".');
  process.exit(1);
}
const keyPrefix = values.DEPLOY_ENV === 'production' ? 'rzp_live_' : 'rzp_test_';
if (!(values.RAZORPAY_KEY_ID || '').startsWith(keyPrefix)) {
  console.error(`Refusing to deploy: ${values.DEPLOY_ENV} requires a ${keyPrefix}… Razorpay key.`);
  process.exit(1);
}

const config = 'dist/server/wrangler.json';
if (!existsSync(config)) {
  console.error('Missing dist/server/wrangler.json — run npm run build:vinext first.');
  process.exit(1);
}

for (const key of [...required, ...optional]) {
  const value = values[key];
  if (!value) {
    if (required.includes(key)) {
      console.error(`Missing required ${key} in .env.local`);
      process.exit(1);
    }
    continue;
  }
  console.log(`Setting secret ${key}…`);
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', key, '--config', config], {
    input: value,
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

console.log('Secrets pushed. Deploy with: npm run deploy:vinext');
