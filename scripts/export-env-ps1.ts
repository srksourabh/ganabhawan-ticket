import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
config({ path: '.env.local', override: true });
const keys = [
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'APP_MODE',
  'SESSION_SECRET',
  'CREDENTIAL_KEY',
  'CRON_SECRET',
  'PAYMENT_PROVIDER',
  'OTP_PROVIDER',
  'ALLOW_PUBLIC_SALES',
  'APP_URL',
];
mkdirSync('.local', { recursive: true });
const lines = keys.map((key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env.local`);
  return `$env:${key} = '${value.replace(/'/g, "''")}'`;
});
writeFileSync('.local/export-env.ps1', `${lines.join('\n')}\n`);
const host = process.env.DATABASE_URL!.split('@')[1]?.split('/')[0];
console.log(`Wrote .local/export-env.ps1 (host ${host})`);
