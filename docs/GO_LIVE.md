# Go-live checklist — Cloudflare Workers + Neon + Razorpay

Three environments. Never mix their databases or keys.

| Environment | `APP_MODE` | `DEPLOY_ENV` | Razorpay keys | Database | Who uses it |
|---|---|---|---|---|---|
| local | `development` | — | none (dev adapter) | embedded Postgres (`npm run db:local`) | developers |
| staging | `live` | `staging` | `rzp_test_…` | separate Neon project/branch | drills, rehearsals |
| production | `live` | `production` | `rzp_live_…` | production Neon | the public |

**Fail-closed rules (enforced in code, `src/lib/env.ts`):**
* Development adapters (OTP code in the response, free "payments", sales-switch bypass) run **only** when `APP_MODE=development` **and** `APP_URL` is explicitly `localhost`/`127.0.0.1` **and** the process is not a Cloudflare Worker. An unset `APP_URL`, or any unknown `APP_MODE` value, counts as live.
* In live mode, every API call returns `503 CONFIG_INVALID`, and `/api/health` returns 503, until all of these are set: `DATABASE_URL`, `SESSION_SECRET`, `CREDENTIAL_KEY` (32+ chars each), `CRON_SECRET`, an https `APP_URL`, `DEPLOY_ENV`, `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID` (`rzp_test_` on staging, `rzp_live_` on production), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, a real `OTP_PROVIDER`, email delivery (`RESEND_API_KEY`+`EMAIL_FROM`, or Composio), and Clerk (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`; the site cannot render pages without them).
* On `DEPLOY_ENV=production`, customer sales also stay closed until Clerk uses a **production instance** (`pk_live_…` and `sk_live_…`). A development instance (`pk_test_…`) shows Clerk's orange "Development mode" badge, caps its users and uses Clerk's shared Google credentials. The two keys must also come from the same kind of instance (`clerkInstanceProblems`). Staff sign-in, admin and gate scanning are not affected.
* `npm run deploy:secrets` refuses to push a development config, a non-https/localhost `APP_URL`, a Razorpay key that doesn't match `DEPLOY_ENV`, or development Clerk keys for production.
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
CREDENTIAL_KEY=<openssl rand -base64 48>   # encrypts ticket QR tokens — never rotate casually (see RUNBOOK)
CRON_SECRET=<openssl rand -base64 32>
OPS_MONITOR_TOKEN=<openssl rand -base64 32>
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=rzp_test_…              # rzp_live_… in production
RAZORPAY_KEY_SECRET=…
RAZORPAY_WEBHOOK_SECRET=…
OTP_PROVIDER=email                       # not development/httpsms
MOBILE_PHONE_NUMBER_ENABLED=false        # email-only launch; true only after MSG91 + DLT are ready (docs/HANDOVER.md 7–8)
RESEND_API_KEY=…
EMAIL_FROM=Samatat Tickets <tickets@your-domain>
ALLOW_PUBLIC_SALES=false                 # true only when the committee opens sales
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=…      # required (pk_live_… in production; Google sign-in for customers). Built INTO the browser bundle: the deploy uses the GitHub repository secret of this name, not the Worker secret
CLERK_SECRET_KEY=…                       # required (sk_live_… from the SAME Clerk instance in production)
```

### Clerk production instance (customer Google sign-in)

1. Clerk dashboard → the Samatat application → create the **Production** instance. Clerk serves production from a domain you own and needs DNS records there, so a `*.workers.dev` URL cannot host it: attach a custom domain to the Worker first.
2. Production → SSO connections → Google: enter your own Google OAuth client ID and secret (Google Cloud console; authorised redirect URI as Clerk shows it). Only enable the sign-in methods you want customers to see. `/login` no longer links to Clerk's `/sign-in` form, but that route still exists and shows every method enabled in the instance (Facebook, email+password, sign-up).
3. Production → Paths/Domains: allow the site's URL as a redirect origin.
4. Set the GitHub repository secret `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` to the `pk_live_…` key. Set the Worker secret `CLERK_SECRET_KEY` to the matching `sk_live_…` key, and also set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` there.
5. Redeploy: the publishable key only changes when the bundle is rebuilt.
6. Check: `/login` loads `clerk.browser.js` from your domain (not `*.clerk.accounts.dev`), `/sign-in` has no "Development mode" badge, and `/api/health` shows `config: true`.

Google accounts created in the development instance do not move to production. Customers sign in again, and their festival account is matched by verified email (`ensureUserFromClerk`), so bookings are kept.

### Sign-in code sender (e.g. otp@samatat.org)

The customer sign-in code is generated and emailed by the app (`src/lib/auth.ts` `requestOtp` → `sendEmail`), not by Clerk. Clerk's email settings do not affect it. The sender is `OTP_FROM_EMAIL` if set, otherwise `EMAIL_FROM`. Confirmations and notices always use `EMAIL_FROM`. The provider is chosen by which secrets are set:

* **Composio Gmail** (`COMPOSIO_API_KEY` + `COMPOSIO_CONNECTED_ACCOUNT_ID`/`COMPOSIO_USER_ID`) is used first whenever it is configured. Mail leaves through the connected Gmail account, so it shows that account's address unless the sender is a verified Gmail "Send mail as" alias. A samatat.org address via Gmail also needs samatat.org's SPF/DMARC to allow Google.
* **Resend** (`RESEND_API_KEY`) is used when Composio is not configured. Verify the domain `samatat.org` in Resend (Domains → add the SPF/DKIM DNS records Resend shows, wait for "Verified"). Resend refuses an unverified sender, and then every code fails with "Email delivery is temporarily unavailable".

To send codes from otp@samatat.org through Resend: verify samatat.org in Resend, then set the Worker secrets `RESEND_API_KEY` and `OTP_FROM_EMAIL=Samatat Natyamela <otp@samatat.org>`. Set `EMAIL_FROM` to a samatat.org address too, because Resend needs it for confirmations. Then remove the three `COMPOSIO_*` Worker secrets so Resend is used, and check `/api/health` shows `config: true`. These are runtime settings, so no rebuild is needed, and none of them is a GitHub secret. A malformed `OTP_FROM_EMAIL` closes customer sales (`config: false`) but not staff access.

### Customer code sign-in (temporarily off)

Customers sign in with Google only while `CUSTOMER_OTP_ENABLED` is unset; no setting is needed for that. To offer the one-time code again, first confirm code delivery works (see the sender section above). Then set the Worker secret `CUSTOMER_OTP_ENABLED=true`; no rebuild or migration is needed. Check that `/login` shows the code form, and request a code to your own address. To turn it off again, delete the secret or set it to `false`.

## 2. Database: migrate (non-destructive)

Migration **0010** adds `festivals.season_sales_open` (the admin's season-ticket switch). It is additive and has a default of `false`, so season-ticket sales start **closed** until an admin opens them in the dashboard. Until 0010 is applied, `/api/health` reports `schema: false` and season tickets cannot be bought; daily tickets are unaffected. Reverse it with `db/rollback/0010_down.sql`.

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

## 4. Staff accounts

```powershell
$env:ENV_FILE=".env.production"
$env:STAFF_PASSWORD="<12+ chars, give it to the person privately>"
npm run db:staff -- add owner@samatat.org owner "Festival owner"
npm run db:staff -- list
```

The owner then creates scanner, supervisor, inventory, finance and desk accounts in the dashboard (Staff tab; see docs/ADMIN_USER_GUIDE.md). Staff sign in with **email + password only** (no authenticator): owner, inventory, finance and desk at `/admin/login`; scanner and supervisor at `/gate/login`. The server admits only each page's roles. Google sign-in and customer codes are refused for staff. Scanners and supervisors are scoped to both gates for every upcoming show automatically, and to every show created later.

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

* The Worker's Cron Trigger (`wrangler.jsonc` `triggers.crons`, handled in `worker/index.ts`) runs one tick every minute through `/api/cron/worker`. It needs the Worker secrets `CRON_SECRET` and `APP_URL`; failed ticks appear under the Worker's Cron Events / logs.
* A tick stays under the Workers Free plan's 50 subrequests per invocation (`tests/integration-worker-budget.test.ts`): 2 jobs, 3 payment reconciliations and 2 refund polls per minute (about 120 confirmations an hour). On the Paid plan raise `WORKER_JOB_BATCH`, `WORKER_RECONCILE_BATCH`, `WORKER_REFUND_BATCH` (e.g. 20/20/10) for faster catch-up.
* GitHub Actions `cron-holds.yml` posts to the same route as a fallback (repository secrets `CRON_SECRET` and `APP_URL`). GitHub's schedule is best-effort and in practice runs every few hours, so it is not the primary scheduler.
* External uptime monitor (UptimeRobot, Better Stack…), alert on any non-200:
  * `GET https://<worker>/api/health` (public)
  * `GET https://<worker>/api/ops/status` with header `Authorization: Bearer <OPS_MONITOR_TOKEN>`. Returns 503 when money is unresolved (unmatched capture, failed/stalled refund) or the worker is stuck.

## 8. Before opening sales

Complete **docs/STAGING_DRILL.md** on staging and record the evidence. Then on production: health 200, `/api/ops/status` 200, `npm run drill:razorpay` all PASS, and only then set `ALLOW_PUBLIC_SALES=true` and publish the festival.

Open commercial decisions in [DECISIONS.md](DECISIONS.md) (**D10, D13, D14, D16**) still need committee sign-off.
