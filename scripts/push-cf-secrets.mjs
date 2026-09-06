#!/usr/bin/env node
/**
 * Push local .env.local values into Wrangler secrets for ganabhawan-festival.
 * Usage: node scripts/push-cf-secrets.mjs
 * Requires: wrangler auth and a built dist/server/wrangler.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const envPath = resolve('.env.local');
if (!existsSync(envPath)) {
  console.error('Missing .env.local — run npm run setup first.');
  process.exit(1);
}

const required = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'CREDENTIAL_KEY',
  'CRON_SECRET',
  'APP_MODE',
  'APP_URL',
  'PAYMENT_PROVIDER',
  'OTP_PROVIDER',
];

const optional = [
  'ALLOW_PUBLIC_SALES',
  'CHROMA_URL',
  'CHROMA_COLLECTION',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'COMPOSIO_API_KEY',
  'COMPOSIO_USER_ID',
  'COMPOSIO_CONNECTED_ACCOUNT_ID',
  'HTTPSMS_API_KEY',
  'HTTPSMS_FROM',
  'CLERK_SECRET_KEY',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
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
