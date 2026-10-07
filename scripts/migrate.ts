/**
 * Applies db/migrations/*.sql that are not yet recorded in schema_migrations.
 *
 * Target selection (one source, never mixed):
 *   1. If DATABASE_URL or DIRECT_DATABASE_URL is set in the shell environment,
 *      ONLY shell values are used (DIRECT_DATABASE_URL first, else DATABASE_URL).
 *      No env file is read for the database URL.
 *   2. Otherwise the file named by ENV_FILE (default .env.local) is read
 *      (DIRECT_DATABASE_URL first, else DATABASE_URL from that file).
 *
 * Safety:
 *   - Prints the target host, database and source before doing anything (never credentials).
 *   - A non-local database is refused unless --confirm-host=<exact host> is given.
 *   - --dry-run lists pending migrations without applying them.
 *
 *   npm run db:migrate                                  # local only
 *   npm run db:migrate -- --dry-run
 *   ENV_FILE=.env.production npm run db:migrate -- --confirm-host=ep-xxxx.region.aws.neon.tech
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const confirmHost = args.find((a) => a.startsWith('--confirm-host='))?.slice('--confirm-host='.length) ?? '';

function resolveTarget(): { url: string; source: string } {
  const shellDirect = process.env.DIRECT_DATABASE_URL?.trim();
  const shellUrl = process.env.DATABASE_URL?.trim();
  if (shellDirect || shellUrl) {
    return shellDirect
      ? { url: shellDirect, source: 'shell DIRECT_DATABASE_URL' }
      : { url: shellUrl!, source: 'shell DATABASE_URL' };
  }
  const file = process.env.ENV_FILE || '.env.local';
  if (!existsSync(file)) throw new Error(`No DATABASE_URL in the shell and ${file} does not exist.`);
  const values = parse(readFileSync(file));
  const direct = values.DIRECT_DATABASE_URL?.trim();
  const url = values.DATABASE_URL?.trim();
  if (direct) return { url: direct, source: `${file} DIRECT_DATABASE_URL` };
  if (url) return { url, source: `${file} DATABASE_URL` };
  throw new Error(`${file} defines neither DIRECT_DATABASE_URL nor DATABASE_URL.`);
}

const { url, source } = resolveTarget();
let host = '';
let database = '';
try {
  const parsed = new URL(url);
  host = parsed.hostname;
  database = parsed.pathname.replace(/^\//, '');
} catch {
  throw new Error(`The database URL from ${source} is not a valid URL.`);
}
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

console.log(`Migration target: database "${database}" on ${host} (${local ? 'LOCAL' : 'REMOTE'}), from ${source}`);
if (!local && confirmHost !== host) {
  console.error(
    `Refusing to migrate a remote database. If you really intend to change "${database}" on ${host}, re-run with --confirm-host=${host}` +
    ' after taking a backup (Neon branch). Use --dry-run first to see what would be applied.',
  );
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const pending = readdirSync('db/migrations').filter((x) => x.endsWith('.sql')).sort().filter((f) => !applied.has(f));
  console.log(pending.length ? `Pending: ${pending.join(', ')}` : 'Nothing to apply.');
  if (dryRun) {
    console.log('Dry run: nothing applied.');
  } else {
    for (const file of pending) {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('festival-migrations'))");
        if (!(await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file])).rowCount) {
          await client.query(readFileSync(`db/migrations/${file}`, 'utf8'));
          await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
          console.log(`Applied ${file}`);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  }
} finally {
  client.release();
  await pool.end();
}
