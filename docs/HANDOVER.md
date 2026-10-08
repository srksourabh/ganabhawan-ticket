# Handover: architecture, staff access, carts, notifications, migrations and go-live

Status: code complete on `atul/unified-cart-checkout` (not merged, not deployed). Migrations 0008 and 0009 are applied to the **staging** Neon database only. Steps marked **[HUMAN]** need the organiser or an administrator. Client-facing instructions: **docs/ADMIN_USER_GUIDE.md**.

| Verification level | Meaning | Status |
|---|---|---|
| Automated | 216 tests (Node 22 + 24), typecheck, lint, Next + Workers builds, bundle secret scan | PASS |
| **STAGING VERIFIED** | Real browser (Chrome) against a local production build connected to the **staging Neon database** | Staff login, both doors, roles, staff creation, logout: 18/18 (8 Oct 2026) |
| Staging Worker | The deployed staging Worker running this branch | **Not done and blocked**: there is no isolated staging Worker (see 12) |
| **PRODUCTION VERIFIED** | Anything on a production Worker/database | **Not done**: no production environment exists yet |

## 0. Architecture summary

One Next.js app (vinext) on one Cloudflare Worker, Neon Postgres, Razorpay checkout, Clerk (customer Google sign-in), customer OTP (email/SMS), a per-minute cron tick for background jobs. Money, inventory, tickets and admissions are decided on the server under database locks; the browser only shows state.

## 0a. Staff authentication

* **One implementation** (`src/lib/auth.ts` `loginStaff`): email (or username) + password, the existing scrypt hashes, rate limits, then the sign-in page's role check, then the existing session (random token, stored hashed, HttpOnly cookie, 12 h expiry, server-side logout). **No authenticator/TOTP/MFA** (removed from the backend, the pages and the CLI; the old `mfa_*` columns remain unused and are cleared when staff are deactivated).
* **Two doors** (`POST /api/auth/password` with `portal`), the role check runs before any session exists:

| Role | `/admin/login` | `/gate/login` | Admin dashboard / APIs | Gate scanning |
|---|---|---|---|---|
| owner | ✔ | ✘ → "use /admin/login" | all sections | ✔ via Check tickets (unchanged: every show/gate) |
| inventory | ✔ | ✘ | festival, dramas, prices, inventory, zones, metrics | ✘ |
| finance | ✔ | ✘ | metrics, accounts/ledger, case resolution | ✘ |
| desk | ✔ | ✘ | none today | ✘ |
| scanner | ✘ → "use /gate/login" | ✔ → `/gate` | ✘ (403; `/admin` sends them to `/gate`) | ✔ per show/gate/device scopes |
| supervisor | ✘ | ✔ → `/gate` | ✘ | ✔ (same as scanner) |
| customer | ✘ | ✘ | ✘ | ✘ |

* Staff can no longer sign in through the customer code (OTP) page or Google; customer sign-in is unchanged.
* **Staff management** (owner, dashboard Staff tab): create scanner/supervisor/inventory/finance/desk with a 12+ character password, reset password (signs out everywhere), deactivate (role → customer, password, scopes and sessions removed), reactivate by adding again. Owners: operator CLI (`npm run db:staff -- add <email> owner`).
* **Gate scopes**: automatic. A scanner/supervisor is scoped to every not-ended, not-cancelled show on every active device when created, and to every show created later. Devices are the two fixed gates (`gate-one` Main entrance, `gate-two` Balcony entrance); no UI for devices or manual scopes (CLI `db:staff -- scopes`).

### Staging accounts created for testing (8 Oct 2026, staging Neon only)

| Account | Status |
|---|---|
| `uds-staging-test-owner@ganabhawan.test` (owner, CLI) | Active. **TEMPORARY credential** for staging testing only, handed over privately (not in the repository). Revoke before real sales: `npm run db:staff -- revoke uds-staging-test-owner@ganabhawan.test "<reason>"` with the staging env |
| `uds-staging-test-scanner@ganabhawan.test` (dashboard) | **Deactivated** after validation (no role, password, scopes or sessions) |
| `uds-staging-test-supervisor@ganabhawan.test` (dashboard) | **Deactivated** after validation |

### Known limitations (staff)

* The Expo mobile app (`mobile/`): its sign-in screen now has "Gate staff? Sign in with email and password", which uses the same staff sign-in (`/api/auth/password`, `portal: 'gate'`, bearer token); customers keep code sign-in. Verified by an automated contract test and by replaying the app's exact HTTP requests against the staging database; the app itself was **not** run on a device (its dependencies are not installed in this workspace). The app's Door tab always scans as gate `gate-one` (Main entrance), unchanged.
* Desk has no dashboard functions yet; supervisors have the same software abilities as scanners (supervision is procedural).
* The door entry window (default 60 min before to 15 min after the start) has no dashboard control.
* Without a second factor, staff accounts are protected by the password alone: use long unique passwords and deactivate leavers promptly.

## 1. Cart identity model

| Who | Where the cart lives | Who can see it |
|---|---|---|
| Guest (not signed in) | This browser only (`localStorage` key `samatat-cart:guest`, plus a random merge id) | Whoever uses this browser while signed out |
| Signed-in customer | The server (`cart_items`, one row per product per account) | That account only, on any device |

An account cart is never written to the browser. Other tabs of the same account are told to re-read it through a content-free ping (`samatat-cart:changed`, a timestamp). Code: `src/lib/account-cart.ts`, `src/lib/cart-storage.ts`, `src/components/CartProvider.tsx`, routes `GET/PUT /api/cart`, `POST /api/cart/merge`.

The cart holds selections only. Inventory is held, priced and charged only at checkout, which re-checks everything server-side as before.

## 2. Guest → account merge

On sign-in the browser sends its guest cart once to `POST /api/cart/merge` with the guest cart's id:

* The merge is recorded per account and guest-cart id (`cart_merges`): repeated sign-in callbacks or a second tab cannot add the guest quantities twice.
* Each guest line is validated live: products that are sold out, closed (any covered performance started, unpublished or cancelled), disabled or deleted are **not added** and are reported back (`notices`: `SOLD_OUT`, `CLOSED`, `UNAVAILABLE`).
* The same product in both carts is combined, but never above the festival's per-ticket maximum, the cart maximum (6 tickets), or what is still available (`REDUCED` / `LIMIT` notices).
* No hold, booking or payment attempt is created. After a successful merge the guest cart is emptied and gets a new id.

## 3. Sign-out and session expiry

* Sign-out (header button, Clerk menu) or an expired session: the browser stops showing the account cart and shows the (normally empty) guest cart. The account cart **stays on the server**.
* Signing in again to the same account restores it. A different customer on the same browser only ever sees their own server cart.
* Nothing of the previous account remains readable in the browser: the account cart was never stored there, and its pending-checkout note (checkout id only) is removed on sign-out. Old per-account browser carts from an earlier version are deleted on load.

## 4. Cart expiry

A line is removed for good when it can never be bought again: **every** performance it covers has ended or been cancelled.

* Daily ticket: after its show's end time, or when the show is cancelled.
* Season ticket: after its **last** covered show ends (not the first).

Until then the line stays and shows its live state. Note the existing sales rule (unchanged): a season pass can be bought only before its first covered show starts, so after the first show a season line stays visible but is marked unavailable and cannot be paid for. Enforcement: every cart read and merge prunes expired lines, the cron tick prunes all accounts (`pruneExpiredCartLines`), and checkout refuses anything not sellable. Confirmed bookings and tickets are never touched. After a checkout is paid, its lines leave the account cart in the confirmation job, even if the browser never came back.

## 5. Contact requirements

| Account | Can buy? |
|---|---|
| Mobile only (signs in with mobile) | Yes |
| Email + verified mobile | Yes |
| Email only | **No**: "Add and verify your mobile number" (HTTP 409, code `MOBILE_REQUIRED`) |
| No verified contact | No |

The rule is enforced server-side before anything is held (`createCheckout`, `reserve`, and both payment-order routes). An email account adds a mobile at checkout: a code is sent to the number (the existing OTP challenge mechanism) and only after the code is proven is it stored as `users.verified_mobile` (`POST/PUT /api/account/mobile`). A number already used by another account is refused. A mobile-only account cannot add an email yet (optional; not built).

## 6. Notification matrix

| Account | After server-confirmed payment |
|---|---|
| Mobile only | 1 SMS |
| Email + mobile | 1 email + 1 SMS |
| Email only | not possible (purchase blocked) |

* Sent only after the server confirms the payment (callback signature + provider fetch, webhook or reconciliation); one DELIVERY job per checkout (unique key), so callback + webhook + reconciliation announce once.
* The email (consolidated, every line, with the physical-ticket instruction) is sent by the DELIVERY job; the SMS is its own NOTIFY job.
* Every send the provider accepted is recorded in `notification_deliveries` (key = job key) and checked before sending: a retried job never repeats a delivered message. Resend also gets the job key as `Idempotency-Key`.
* Residual risk: if the provider accepts a message and the database write right after it fails, a retry may send once more (MSG91 has no idempotency key).

## 7. MSG91 environment variables (names only; values are secrets)

| Variable | Meaning |
|---|---|
| `SMS_PROVIDER` | `msg91` (or `httpsms` / `generic`) |
| `MSG91_AUTH_KEY` | MSG91 API auth key (server-only; in the bundle secret scan) |
| `MSG91_TEMPLATE_ID` | MSG91 **flow** template id |
| `MSG91_SENDER_ID` | Sender/header (optional if set on the flow) |
| `MSG91_TEMPLATE_VARIABLES` | Template variable names → our values, e.g. `var1=REFERENCE,var2=SHOW,var3=LINK` |
| `SMS_CONFIRMATION_TEXT` | Exact text for free-text providers (httpSMS/generic), placeholders `{REFERENCE} {SHOW} {LINK} {NAME}` |

Live mode refuses to start sales without a working SMS provider (mobile-only customers would otherwise get nothing). Sign-in codes (OTP) keep their existing path (`OTP_PROVIDER`, httpSMS for mobiles).

## 8. MSG91 / DLT setup **[HUMAN]**

1. Register the sender/header and the transactional template with DLT (TRAI) through the operator/MSG91. Suggested text: "Your Ganabhawan ticket booking {#var#} is confirmed for {#var#}. View your tickets: {#var#}".
2. In MSG91, create a Flow template from the approved DLT template (this links the DLT template id and header); note the flow template id and its variable names.
3. Set `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, `MSG91_SENDER_ID`, `MSG91_TEMPLATE_VARIABLES` as Worker secrets (`npm run deploy:secrets` with the staging env file). Never in git or `.env.example`.
4. Send one test SMS from staging to a controlled number (section 14).

The DLT template id is attached to the flow template inside MSG91; the app sends the flow template id. Confirm with MSG91 that the account's flow API needs nothing more.

## 9. SMS failure and retry

An SMS failure (provider down, error response) fails only its NOTIFY job: it retries after 2, 4, 8 and 16 minutes, then becomes FAILED (an ops warning). The booking stays CONFIRMED, the payment and tickets are untouched, nothing is refunded, and the email (if any) is sent independently. Email failure is symmetrical.

## 10. Staging migration (done 8 Oct 2026)

```
ENV_FILE=.env.local npm run db:migrate -- --dry-run --confirm-host=ep-morning-bird-azhfkjmb.c-3.ap-southeast-1.aws.neon.tech
ENV_FILE=.env.local npm run db:migrate -- --confirm-host=ep-morning-bird-azhfkjmb.c-3.ap-southeast-1.aws.neon.tech
```

Applied 0008 and 0009; the follow-up dry run reported "Nothing to apply". Both are additive and compatible with the code currently deployed.

## 11. Production migration (template — DO NOT RUN until approved) **[HUMAN]**

```
ENV_FILE=.env.production npm run db:migrate -- --dry-run --confirm-host=<PRODUCTION_NEON_DIRECT_HOST>
ENV_FILE=.env.production npm run db:migrate -- --confirm-host=<PRODUCTION_NEON_DIRECT_HOST>
```

Run the dry run first and apply only if it lists exactly the expected migrations. Migrate **before** deploying the code (the deploy workflow does not migrate).

## 12. Staging deployment requirements **[HUMAN]**

* There is currently ONE Worker (`ganabhawan-festival`, no `env` sections); it serves the public URL, runs `DEPLOY_ENV=staging`, and `main` deploys to it automatically. **It is not isolated from production: do not deploy this branch there as a "staging test".** Create an isolated staging Worker first: add `env.staging` to `wrangler.jsonc` (its own name, e.g. `ganabhawan-festival-staging`, with `version_metadata` and `triggers` repeated), give it its own secrets (staging Neon `DATABASE_URL`, Clerk test keys, `rzp_test_` keys and webhook secret, `APP_URL` = the staging workers.dev URL, `CRON_SECRET`, SMS), register the Razorpay TEST webhook to its URL, and deploy with `npx vinext-cloudflare deploy --env staging`. **[HUMAN]** (needs Cloudflare access).
* Worker secrets: SMS (section 7) in addition to the existing ones; `CRON_SECRET` and `APP_URL` (cron trigger).
* Razorpay TEST webhook: `https://<worker>/api/payments/webhook/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`, events `payment.captured`, `payment.authorized`, `order.paid`, `refund.processed`, `refund.failed`.
* Deploy = merge to `main` (CI then deploys) or `npm run build:vinext && npm run deploy:vinext` with the staging Clerk publishable values.

## 13. Production deployment requirements **[HUMAN]**

* A separate production Worker and production Neon database; production migration (section 11) before deploy.
* `rzp_live_` keys and a live webhook; DLT-approved SMS template; Resend domain verified.
* Workers Paid plan recommended (cron batch defaults are sized for the Free plan's 50 subrequests: 2 jobs, 3 reconciliations, 2 refund polls per minute; raise `WORKER_JOB_BATCH` / `WORKER_RECONCILE_BATCH` / `WORKER_REFUND_BATCH` on Paid).
* Admin: configure capacities and allocations, season tickets and prices; create staff accounts (Staff tab).

## 14. Final staging E2E checklist **[HUMAN]** (Razorpay TEST, controlled phone/email only)

Cart: add as guest → sign in → guest lines appear in the account cart → add another → sign out → account cart not visible → sign in again → cart back → sign in as another customer → previous cart not visible → let the session expire (12 h, or delete the session) → sign in → cart back → end a show (admin: past time) → its line disappears → season line stays until its last show.

Payment: several lines → one checkout → pay with Razorpay TEST → all bookings CONFIRMED → one consolidated email + one SMS → jobs DONE → webhook delivery visible in the Razorpay dashboard → close the browser right after paying (reconciliation confirms) → failed payment then retry → late payment after hold expiry.

SMS: mobile-only account → SMS; email + mobile account → email and SMS; provider failure (wrong key in a copy of the env) → booking stays confirmed, NOTIFY job retries; restoring the key sends exactly one SMS.
