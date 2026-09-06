import { readFileSync, readdirSync } from 'node:fs';
import { config } from 'dotenv';
import pg from 'pg';
config({ path: '.env.local', quiet: true });
const pool = new pg.Pool({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
const client = await pool.connect();
try {
 await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
 for (const file of readdirSync('db/migrations').filter(x => x.endsWith('.sql')).sort()) {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('festival-migrations'))");
  if (!(await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file])).rowCount) {
   await client.query(readFileSync(`db/migrations/${file}`, 'utf8')); await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]); console.log(`Applied ${file}`);
  }
  await client.query('COMMIT');
 }
} catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await pool.end(); }
