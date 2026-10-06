#!/usr/bin/env node
/**
 * Fails if the browser bundle (dist/client after `npm run build:vinext`)
 * references server-only secrets, or contains secret-shaped values.
 * Usage: node scripts/check-bundle-secrets.mjs [dir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || 'dist/client';
const SERVER_ONLY = [
  'DATABASE_URL', 'DIRECT_DATABASE_URL', 'SESSION_SECRET', 'CREDENTIAL_KEY', 'CRON_SECRET', 'OPS_MONITOR_TOKEN',
  'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RESEND_API_KEY', 'COMPOSIO_API_KEY', 'HTTPSMS_API_KEY',
  'SMS_API_TOKEN', 'CLERK_SECRET_KEY', 'ADMIN_PASSWORD', 'STAFF_PASSWORD',
];
const VALUE_PATTERNS = [/sk_(live|test)_[A-Za-z0-9]{20,}/, /re_[A-Za-z0-9]{20,}/, /postgres(ql)?:\/\/[^\s"']+:[^\s"']+@/];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(m?js|html|json|css|map)$/.test(name)) yield path;
  }
}

let findings = 0;
let scanned = 0;
for (const file of files(root)) {
  scanned += 1;
  const text = readFileSync(file, 'utf8');
  // `{}.NAME` is the bundler's stub for process.env.NAME: always undefined in the browser (no value shipped).
  const stripped = text.replace(/\{\}\.[A-Z_]+/g, '');
  for (const name of SERVER_ONLY) if (stripped.includes(name)) { console.error(`server secret name ${name} in ${file}`); findings += 1; }
  for (const pattern of VALUE_PATTERNS) if (pattern.test(text)) { console.error(`secret-shaped value ${pattern} in ${file}`); findings += 1; }
}
console.log(`Scanned ${scanned} client files under ${root}: ${findings} finding(s).`);
process.exit(findings ? 1 : 0);
