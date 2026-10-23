# Go-live checklist — Cloudflare Workers + Neon + Razorpay

Three environments. Never mix their databases or keys.

| Environment | `APP_MODE` | `DEPLOY_ENV` | Razorpay keys | Database | Who uses it |
|---|---|---|---|---|---|
| local | `development` | — | none (dev adapter) | embedded Postgres (`npm run db:local`) | developers |
| staging | `live` | `staging` | `rzp_test_…` | separate Neon project/branch | drills, rehearsals |
| production | `live` | `production` | `rzp_test_…` while testing, then `rzp_live_…` | production Neon | the public |

**Fail-closed rules (enforced in code, `src/lib/env.ts`):**
* Development adapters (OTP code in the response, free "payments", sales-switch bypass) run **only** when `APP_MODE=development` **and** `APP_URL` is explicitly `localhost`/`127.0.0.1` **and** the process is not a Cloudflare Worker. An unset `APP_URL`, or any unknown `APP_MODE` value, counts as live.
* In live mode, the configuration is checked in parts (`src/lib/config-gate.ts`): a core problem (database, secrets, URL) refuses every API; a customer problem (Clerk, OTP provider, email) refuses customer APIs; a **payment** problem (Razorpay settings) only refuses the purchase APIs (`/api/holds`, `/api/checkouts`, `/api/payments/`) and shows tickets as "Sales closed", while sign-in codes, accounts and bookings keep working. Before this split, every API call returned `503 CONFIG_INVALID`, and `/api/health` returns 503, until all of these are set: `DATABASE_URL`, `SESSION_SECRET`, `CREDENTIAL_KEY` (32+ chars each), `CRON_SECRET`, an https `APP_URL`, `DEPLOY_ENV`, `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID` (`rzp_test_` on staging; `rzp_test_` or `rzp_live_` on production, see "Razorpay test and live mode"), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, a real `OTP_PROVIDER`, email delivery (`RESEND_API_KEY`+`EMAIL_FROM`, or Composio), and Clerk (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`; the site cannot render pages without them).
* On `DEPLOY_ENV=production`, customer sales also stay closed until Clerk uses a **production instance** (`pk_live_…` and `sk_live_…`). A development instance (`pk_test_…`) shows Clerk's orange "Development mode" badge, caps its users and uses Clerk's shared Google credentials. The two keys must also come from the same kind of instance (`clerkInstanceProblems`). Staff sign-in, admin and gate scanning are not affected.
* `npm run deploy:secrets` refuses to push a development config, a non-https/localhost `APP_URL`, a Razorpay key that is not `rzp_test_`/`rzp_live_`, a live key on staging, a key that does not match `RAZORPAY_MODE`, or development Clerk keys for production.
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

### Temporary: production on the Clerk development instance

Until the Clerk production instance exists, set the Worker secret `CLERK_DEVELOPMENT_INSTANCE_ALLOWED=true`. Production then accepts the current development keys (`pk_test_…` / `sk_test_…`), and customer sales can open once every other requirement passes. Leave it unset to keep the strict rule (`pk_live_…` / `sk_live_…`). Exactly `true` turns it on; any other value is off.

What it does **not** change:
* Clerk still verifies every session. The secret key stays server-side.
* Google sign-in still never gives staff powers. Staff sign in with passwords.
* Both keys must still be real Clerk keys from the same kind of instance.
* Every other requirement still applies: database, session and credential keys, `APP_URL`, `CRON_SECRET`, Razorpay **live** key and secrets, email delivery and `ALLOW_PUBLIC_SALES`.

Limitations of serving the public from a Clerk **development** instance:
* Customers see Clerk's orange "Development mode" badge.
* Development instances cap their users (see Clerk's current limits).
* Google sign-in uses Clerk's shared OAuth app, so the consent screen does not show your brand.
* Sessions go through Clerk's development handshake on `*.clerk.accounts.dev`.
* Accounts made there do not move to the production instance. Customers sign in again later and are re-linked by verified email, keeping their bookings.

Remove the override as soon as the production instance below is live.

The owner (or `OPS_MONITOR_TOKEN`) can see exactly which settings block sales, by name, never by value: `GET /api/ops/status` → `configuration.salesProblems`.

### Clerk production instance (customer Google sign-in)

1. Clerk dashboard → the Samatat application → create the **Production** instance. Clerk serves production from a domain you own and needs DNS records there, so a `*.workers.dev` URL cannot host it: attach a custom domain to the Worker first.
2. Production → SSO connections → Google: enter your own Google OAuth client ID and secret (Google Cloud console; authorised redirect URI as Clerk shows it). Only enable the sign-in methods you want customers to see. `/login` no longer links to Clerk's `/sign-in` form, but that route still exists and shows every method enabled in the instance (Facebook, email+password, sign-up).
3. Production → Paths/Domains: allow the site's URL as a redirect origin.
4. Set the GitHub repository secret `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` to the `pk_live_…` key. Set the Worker secret `CLERK_SECRET_KEY` to the matching `sk_live_…` key, and also set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` there.
5. Redeploy: the publishable key only changes when the bundle is rebuilt.
6. Check: `/login` loads `clerk.browser.js` from your domain (not `*.clerk.accounts.dev`), `/sign-in` has no "Development mode" badge, and `/api/health` shows `config: true`.

Google accounts created in the development instance do not move to production. Customers sign in again, and their festival account is matched by verified email (`ensureUserFromClerk`), so bookings are kept.

### Razorpay test and live mode

One production deployment runs in either Razorpay mode. The mode is decided only by server settings (Worker secrets), never by a request:

* `RAZORPAY_MODE` (optional, `test` or `live`) is an interlock. When set, the key id must match it (`rzp_test_…` for `test`, `rzp_live_…` for `live`); a mismatch, an unknown value or a non-Razorpay key keeps sales closed ("Sales closed" on the seat map, `publicSales:false`) and lists the problem in Admin → Ops. Unset, the mode is read from the key id.
* `/api/health` shows `paymentMode` (`test`, `live` or `null`).
* Every Razorpay order records the mode it was created in (`payment_attempts.provider_mode`, migration 0011). Switching keys later never reinterprets an earlier payment:
  * test payments are not counted as income in Admin → Accounts (shown separately as "Test payments", rows marked TEST);
  * test-mode ticket emails say **[TEST]** in the subject and carry a "TEST BOOKING" banner;
  * once the deployment is live, a ticket paid in test mode is refused at the gate ("Test ticket … not valid for entry");
  * refunds and payment reconciliation only call Razorpay with the keys of the payment's own mode. A test-mode refund requested after going live stays `REQUESTED` and opens a reconciliation case `refund-mode:<refund id>`; it is never marked refunded without Razorpay's confirmation.
* Migration 0011 must be applied before taking payments you want tracked by mode. Without it the app still works, but every payment is treated as the current mode, and Admin → Ops warns.
* **Payments from before 0011** keep `provider_mode` NULL ("not recorded"). Nothing guesses test or live for them: Razorpay order and payment ids do not say which environment they belong to, and the live-key rule for production only dates from 5 October 2026. They count as income and admit at the gate as before. Their refunds and reconciliation use the current keys, and Razorpay itself checks the mode: an environment that does not know the payment rejects the call, so the refund stays `REQUESTED` (retried, alert logged) and is never marked refunded or failed. To settle one, switch to the keys of the environment that took it, or refund it in that Razorpay Dashboard and record it under Admin → Cases.

Apply 0011 (additive: one nullable column and a CHECK; no row is changed) only with a verified backup:

```
# 1. Neon console → the production branch → Backup & restore: create a branch/snapshot now; note its name.
# 2. A fresh direct (non-pooled) connection string for the production branch, in the shell only:
export DIRECT_DATABASE_URL='postgresql://…'          # never in a committed file
npm run db:migrate -- --dry-run                       # shows host, database and "Pending: 0011_payment_mode.sql"
npm run db:migrate -- --confirm-host=<host printed above>
# 3. Check:
#    SELECT column_name, data_type, is_nullable FROM information_schema.columns
#     WHERE table_name='payment_attempts' AND column_name='provider_mode';      -- text, YES
#    SELECT name, applied_at FROM schema_migrations WHERE name='0011_payment_mode.sql';
#    SELECT count(*), count(provider_mode) FROM payment_attempts;               -- same total as before, 0 recorded
unset DIRECT_DATABASE_URL
```

Reverse with `db/rollback/0011_down.sql` (drops only the column and its record).

**Test mode** (Worker secrets, Settings → Variables and Secrets; no rebuild):

```
PAYMENT_PROVIDER=razorpay
RAZORPAY_MODE=test
RAZORPAY_KEY_ID=rzp_test_…           # Razorpay Dashboard in Test Mode → Account & Settings → API Keys
RAZORPAY_KEY_SECRET=…                # the matching test key secret
RAZORPAY_WEBHOOK_SECRET=…            # secret of the webhook created in Test Mode
```

Create the webhook (section 6) in the Razorpay Dashboard **with Test Mode on**. Pay with Razorpay's test cards/UPI; no real money moves.

**Live mode**: replace the same four values in Cloudflare and nothing else (no code change, rebuild or data change):

```
RAZORPAY_MODE=live
RAZORPAY_KEY_ID=rzp_live_…           # Dashboard in Live Mode → API Keys (needs KYC/activation)
RAZORPAY_KEY_SECRET=…                # the matching live key secret
RAZORPAY_WEBHOOK_SECRET=…            # secret of the webhook created in Live Mode
```

Create the webhook again in Live Mode (test and live webhooks are separate in Razorpay). Then check `/api/health` shows `paymentMode: "live"` and `publicSales: true`, and make one small real purchase and refund. Before opening to the public, cancel or refund any test bookings that still hold seats (Admin), because test holds and test bookings use real inventory.

### Sending email from tickets@samatat.org

All app email (sign-in codes, ticket confirmations, notices) goes through `sendEmail`: Composio Gmail first when its secrets are set, otherwise Resend. To send from tickets@samatat.org with Resend:

1. In Resend → Domains, add `samatat.org` and create the SPF (TXT/MX on `send.samatat.org`) and DKIM (`resend._domainkey`) DNS records it shows at the domain's DNS host. Wait for "Verified". Add a DMARC record (`_dmarc.samatat.org`, e.g. `v=DMARC1; p=none;`) if there is none.
2. Create a Resend API key with "Sending access" for samatat.org.
3. Worker secrets: `RESEND_API_KEY=re_…`, `EMAIL_FROM=Samatat Tickets <tickets@samatat.org>`. Leave `OTP_FROM_EMAIL` unset (codes then also come from tickets@samatat.org) or set it to another verified samatat.org address.
4. Delete the Worker secrets `COMPOSIO_API_KEY`, `COMPOSIO_USER_ID`, `COMPOSIO_CONNECTED_ACCOUNT_ID`; while they exist, Composio Gmail is used instead.
5. Check `/api/health` (`config: true`) and request a sign-in code to a test mailbox. Email settings are independent of the Razorpay mode.

To keep Composio Gmail instead, tickets@samatat.org must be a verified "Send mail as" alias of the connected Gmail account and samatat.org's SPF must include Google.

### Sign-in code sender (e.g. otp@samatat.org)

The customer sign-in code is generated and emailed by the app (`src/lib/auth.ts` `requestOtp` → `sendEmail`), not by Clerk. Clerk's email settings do not affect it. The sender is `OTP_FROM_EMAIL` if set, otherwise `EMAIL_FROM`. Confirmations and notices always use `EMAIL_FROM`. The provider is chosen by which secrets are set:

* **Composio Gmail** (`COMPOSIO_API_KEY` + `COMPOSIO_CONNECTED_ACCOUNT_ID`/`COMPOSIO_USER_ID`) is used first whenever it is configured. Mail leaves through the connected Gmail account, so it shows that account's address unless the sender is a verified Gmail "Send mail as" alias. A samatat.org address via Gmail also needs samatat.org's SPF/DMARC to allow Google.
* **Resend** (`RESEND_API_KEY`) is used when Composio is not configured. Verify the domain `samatat.org` in Resend (Domains → add the SPF/DKIM DNS records Resend shows, wait for "Verified"). Resend refuses an unverified sender, and then every code fails with "Email delivery is temporarily unavailable".

To send codes from otp@samatat.org through Resend: verify samatat.org in Resend, then set the Worker secrets `RESEND_API_KEY` and `OTP_FROM_EMAIL=Samatat Natyamela <otp@samatat.org>`. Set `EMAIL_FROM` to a samatat.org address too, because Resend needs it for confirmations. Then remove the three `COMPOSIO_*` Worker secrets so Resend is used, and check `/api/health` shows `config: true`. These are runtime settings, so no rebuild is needed, and none of them is a GitHub secret. A malformed `OTP_FROM_EMAIL` closes customer sales (`config: false`) but not staff access.

### Guest checkout and ticket emails

* **Guest checkout** needs no setting. A guest types a name, email and mobile; nothing proves the email is theirs, so the guest session is *purchase-only*: it never signs anyone into the account behind that email (no booking history, tickets, cart or details), and it can act only on the checkout it created. Bookings are recorded under that email's customer record, so the real owner sees them after signing in with Google.
* **Ticket email**: after the payment is verified, the customer gets an HTML email (with a plain-text alternative when sent through Resend; the Composio Gmail tool sends the HTML only) listing every ticket with its own ticket number and QR code. The QR images are served from `/api/ticket-qr/<signed code>` (no session; stops working when a ticket is cancelled).
* **Organisation copy**: every ticket confirmation is also sent, as a separate email, to `samatat.sanskritiuttarpara2000@gmail.com`. Set the Worker variable `TICKET_COPY_EMAIL` to change it, or to `off` to stop it. That mailbox receives every ticket's QR code: keep it protected (2-step verification, few people).
* **Before relying on it**: send one real test purchase and check both inboxes, the QR images and the spam folder. Email delivery was tested only with an in-process fake.

### Customer code sign-in (email only)

Customers sign in with Google only while `CUSTOMER_OTP_ENABLED` is unset. To offer the **email** one-time code, first confirm code delivery works (see the sender section above). Then set the Worker secret `CUSTOMER_OTP_ENABLED=true`; no rebuild or migration is needed. This never enables mobile/SMS codes: a mobile number is refused and no SMS is sent while `MOBILE_PHONE_NUMBER_ENABLED` is unset or `false` (leave it so). MSG91 settings are then not needed. Check that `/login` shows the code form, and request a code to your own address. To turn it off again, delete the secret or set it to `false`.

## 2. Database: migrate (non-destructive)

The current code needs migrations up to **0009** and nothing later; `/api/health` `schema` checks for what it uses (0007 checkouts, 0008 season allocations, 0009 account carts). There is no migration 0010: the season-ticket switch is the runtime setting below, not a database column.

### Season-ticket sales (runtime setting)

New season-ticket sales are controlled by the Worker variable `SEASON_TICKET_SALES_ENABLED`. Exactly `true` opens them; unset or anything else keeps them **closed** (the default). Change it in Cloudflare (Worker → Settings → Variables and Secrets); the admin dashboard only shows it. No rebuild, deploy or migration is needed. It never overrides `ALLOW_PUBLIC_SALES`: season tickets sell only when both are `true` and the zone's season ticket is **On sale**. `/api/health` reports `seasonSales`. Closing it refuses new season holds, checkouts and payment orders; existing season bookings, tickets, QR codes, admission and completed payments are not affected.

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

* Webhook URL: `https://<worker>/api/payments/webhook/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`. Create one in Test Mode and one in Live Mode; use the secret of the mode in use.
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
