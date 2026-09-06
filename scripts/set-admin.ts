/**
 * Create / update the owner admin with email + password.
 * Usage: npx tsx scripts/set-admin.ts
 * Env: ADMIN_EMAIL, ADMIN_PASSWORD, optional ADMIN_USERNAME / ADMIN_NAME
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config({ path: '.env' });

import { upsertStaffPassword } from '../src/lib/auth';
import { pool } from '../src/lib/db';

const email = process.env.ADMIN_EMAIL || 'srksourabh@gmail.com';
const password = process.env.ADMIN_PASSWORD || '';
const username = process.env.ADMIN_USERNAME || 'admin';
const name = process.env.ADMIN_NAME || 'Sourabh';

if (password.length < 8) {
  console.error('Set ADMIN_PASSWORD in .env.local (at least 8 characters), then re-run.');
  process.exit(1);
}

const user = await upsertStaffPassword(email, password, name, username);
console.log(`Admin ready: ${user.contact} (username: ${username}, role: ${user.role})`);
await pool.end();
