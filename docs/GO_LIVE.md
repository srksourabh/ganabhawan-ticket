# Go-live checklist — Cloudflare Workers + Neon + Razorpay

Three environments. Never mix their databases or keys.

| Environment | `APP_MODE` | `DEPLOY_ENV` | Razorpay keys | Database | Who uses it |
|---|---|---|---|---|---|
| local | `development` | — | none (dev adapter) | embedded Postgres (`npm run db:local`) | developers |
| staging | `live` | `staging` | `rzp_test_…` | separate Neon project/branch | drills, rehearsals |
| production | `live` | `production` | `rzp_live_…` | production Neon | the public |

**Fail-closed rules (enforced in code, `src/lib/env.ts`):**
* Development adapters (OTP code in the response, staff MFA skip, free "payments", sales-switch bypass) run **only** when `APP_MODE=development` **and** `APP_URL` is explicitly `localhost`/`127.0.0.1` **and** the process is not a Cloudflare Worker. An unset `APP_URL`, or any unknown `APP_MODE` value, counts as live.
* In live mode, every API call returns `503 CONFIG_INVALID`, and `/api/health` returns 503, until all of these are set: `DATABASE_URL`, `SESSION_SECRET`, `CREDENTIAL_KEY` (32+ chars each), `CRON_SECRET`, an https `APP_URL`, `DEPLOY_ENV`, `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID` (`rzp_test_` on staging, `rzp_live_` on production), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, a real `OTP_PROVIDER`, email delivery (`RESEND_API_KEY`+`EMAIL_FROM`, or Composio), and Clerk (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`; the site cannot render pages without them).
* `npm run deploy:secrets` refuses to push a development config, a non-https/localhost `APP_URL`, or a Razorpay key that doesn't match `DEPLOY_ENV`.
* `npm run db:seed` refuses any non-local database, and any database that has payments or confirmed bookings.

## 1. Accounts and environment files

Keep one untracked file per environment (`.env*` is git-ignored): `.env.staging`, `.env.production`.

```env
APP_MODE=live
DEPLOY_ENV=staging                      # or production
APP_URL=https://<worker>.workers.dev    # the exact public URL
DATABASE_URL=postgresql://…neon.tech/…  # pooled
DIRECT_DATABASE_URL=postgresql://…      # direct, for migrations
SESSION_SECRET=<openssl rand -base64 48>
CREDENTIAL_KEY=<openssl rand -base64 48>   # encrypts QR tokens and staff MFA secrets — never rotate casually (see RUNBOOK)
CRON_SECRET=<openssl rand -base64 32>
OPS_MONITOR_TOKEN=<openssl rand -base64 32>
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=rzp_test_…              # rzp_live_… in production
RAZORPAY_KEY_SECRET=…
RAZORPAY_WEBHOOK_SECRET=…
OTP_PROVIDER=email                       # or httpsms (+ HTTPSMS_API_KEY/HTTPSMS_FROM)
RESEND_API_KEY=…
EMAIL_FROM=Samatat Tickets <tickets@your-domain>
ALLOW_PUBLIC_SALES=false                 # true only when the committee opens sales
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=…      # required (pk_live_… in production; Google sign-in for customers)
CLERK_SECRET_KEY=…                       # required
```

## 2. Database: migrate (non-destructive)

```powershell
# 1. Backup first (production): Neon console → Branches → create branch "pre-<version>" from main (instant, restorable).
$env:DIRECT_DATABASE_URL="<direct url>"; npm run db:migrate -- --dry-run             # shows target host + pending files
npm run db:migrate -- --confirm-host=<exact host printed above>   # remote targets are refused without this
```

Migrations are additive (`db/migrations/0006_production_remediation.sql` adds nullable or defaulted columns and widens one CHECK). The reversal is `db/rollback/0006_down.sql`, which you only need if the schema itself must be reverted (see RUNBOOK §Rollback).

**Order matters for 0007 (one payment per cart).** The deploy workflow (`.github/workflows/deploy.yml`) ships code on every merge to `main` but never migrates. Apply `0007_checkouts.sql` to staging, then production (each after a Neon backup branch), **before** merging the branch that uses it. 0007 is additive, and the code already on `main` keeps working on it (verified). `/api/health` reports `"schema": false` (HTTP 503) if a deploy gets ahead of the schema. Reversal: `db/rollback/0007_down.sql` (refuses once any cart checkout exists).

**Never run `npm run db:seed` against staging or production.** To load a programme use the admin dashboard (Festival → Dramas), or `node scripts/update-show-artwork.mjs` for artwork only.

## 3. Clean up the old development deployment (production database)

The Worker deployed on 6 Sep 2026 ran development adapters on seeded data. Before opening sales:

Operator scripts read the environment named by `ENV_FILE` (default `.env.local`). Any script that writes refuses a development configuration against a non-local database, and development adapters never act on a non-local database at all.

```powershell
$env:ENV_FILE=".env.production"
npm run db:purge-synthetic                 # dry run: lists @example.test accounts, sessions, scopes, bookings
npm run db:purge-synthetic -- --apply      # demotes them, removes sessions and gate scopes (keeps records)
```

Then **rotate** `SESSION_SECRET` and `CRON_SECRET`, and delete all sessions (`DELETE FROM sessions;`) so nobody keeps a session minted in development mode. Treat `CREDENTIAL_KEY` as compromised only if it was ever exposed. Rotating it voids every issued QR code and staff MFA enrolment (RUNBOOK §Secrets).

## 4. Staff and authenticators

```powershell
$env:ENV_FILE=".env.production"            # the same CREDENTIAL_KEY as the deployed Worker; enrolment refuses a mismatched key
$env:STAFF_PASSWORD="<12+ chars, give it to the person privately>"
npm run db:staff -- add owner@samatat.org owner "Festival owner"
npm run db:staff -- mfa-enroll owner@samatat.org     # scan the QR on the owner's phone
npm run db:staff -- mfa-confirm owner@samatat.org 123456
# repeat for finance / inventory / scanner / supervisor accounts
npm run db:staff -- list
```

Scanners and supervisors are scoped to both gates for every upcoming show automatically, and to every show created later. Sign-in: `/admin/login` with email + password + authenticator code. Google sign-in is refused for staff.

## 5. Build, secrets, deploy

```powershell
npm ci; npm run check; npm run build:vinext; node scripts/check-bundle-secrets.mjs dist/client
node scripts/push-cf-secrets.mjs .env.staging      # or .env.production
npm run deploy:vinext
```

## 6. Razorpay dashboard

* Webhook URL: `https://<worker>/api/payments/webhook/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`.
* Events: `payment.captured`, `payment.authorized`, `order.paid`, `refund.processed`, `refund.failed`.
* Payment capture: automatic (the app also captures authorized payments itself).

## 7. Scheduler and monitoring

* GitHub Actions `cron-holds.yml` posts to `/api/cron/worker` every 2 minutes. Set the repository secrets `CRON_SECRET` and `APP_URL`. GitHub cron is best-effort; the external monitor below catches a stopped worker.
* External uptime monitor (UptimeRobot, Better Stack…), alert on any non-200:
  * `GET https://<worker>/api/health` (public)
  * `GET https://<worker>/api/ops/status` with header `Authorization: Bearer <OPS_MONITOR_TOKEN>`. Returns 503 when money is unresolved (unmatched capture, failed/stalled refund) or the worker is stuck.

## 8. Before opening sales

Complete **docs/STAGING_DRILL.md** on staging and record the evidence. Then on production: health 200, `/api/ops/status` 200, `npm run drill:razorpay` all PASS, and only then set `ALLOW_PUBLIC_SALES=true` and publish the festival.

Open commercial decisions in [DECISIONS.md](DECISIONS.md) (**D10, D13, D14, D16**) still need committee sign-off.
