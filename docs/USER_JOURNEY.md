# User journeys: Ganabhawan / UDS ticketing

## 1. Purpose and scope

This document describes how people actually move through the ticketing system as implemented on branch `atul/unified-cart-checkout` (October 2026). It is written for product, QA, development and operations.

It covers: customer browsing, sign-in, cart, checkout, payment, confirmation, ticket and QR access, gate admission, staff and admin use, notifications, configuration switches, failure handling, and what has and has not been verified.

Status labels used in this document:

| Label | Meaning |
|---|---|
| **Automated test** | Proven by the automated suite against a local Postgres with fake Razorpay / Resend / MSG91 |
| **Reviewed** | Read in the code, not executed |
| **Not verified** | Needs a real provider or an isolated staging environment |

Nothing in this document has been verified in an isolated staging environment or with a real email, SMS or payment provider (see section 15).

## 2. Actors and roles

| Actor | What it is in the system |
|---|---|
| Customer | A `users` row with `role='customer'`. Signs in with an emailed code, Google (Clerk), or (only when mobile features are on) an SMS code |
| Owner | `role='owner'`. Full admin dashboard; passes every role check (including gate scanning) |
| Inventory | `role='inventory'`. Catalogue, shows, inventory, posters, metrics |
| Finance | `role='finance'`. Metrics and reconciliation cases |
| Desk | `role='desk'`. Admin door sign-in; no dashboard area is granted to it by `ADMIN_POLICY` |
| Scanner, Supervisor | Gate staff. Sign in at `/gate/login`, scan tickets for the shows/gates/devices they are scoped to |
| Razorpay | Payment provider (orders, payments, refunds, webhooks) |
| Resend (or Composio Gmail) | Email provider |
| MSG91 | SMS provider, used only when mobile features are on |
| Cloudflare cron | Runs the background tick every minute |

Staff accounts never sign in with customer codes or Google; they use email/username + password at their door (section 11).

## 3. Configuration and feature switches

Three independent levels decide what works. Each is reported by `GET /api/health` as a boolean (never a value or a setting name).

| Level | Health field | What it needs | What it controls |
|---|---|---|---|
| Core | `staff` | `DATABASE_URL`, `SESSION_SECRET` and `CREDENTIAL_KEY` (32+ chars), public `https` `APP_URL`, `DEPLOY_ENV`, Clerk keys | Everything. If core is broken, every API (staff included) answers 503 |
| Customer-sales settings | `config` | `CRON_SECRET`, `PAYMENT_PROVIDER=razorpay` + Razorpay keys (test keys on staging, live keys on production), `OTP_PROVIDER` not `development`/`httpsms`, email delivery (`RESEND_API_KEY` + `EMAIL_FROM`, or Composio) | Customer APIs (cart, holds, checkout, payments, customer sign-in). Missing ones give `CONFIG_INVALID` "not configured for sales yet". Staff APIs stay open |
| Public sales | `publicSales` | `config` true AND `ALLOW_PUBLIC_SALES` exactly `true` | Whether holds and checkouts can be created. Any other value (missing, `TRUE`, `yes`) means sales are paused |
| Mobile features | `mobile` | `MOBILE_PHONE_NUMBER_ENABLED` exactly `true` (case-insensitive) AND `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_TEMPLATE_ID` | Mobile sign-in, adding a mobile, every customer SMS. Missing, `false` or malformed means off (fail closed) |

MSG91 is **not** a customer-sales requirement. Optional MSG91 settings: `MSG91_SENDER_ID`, `MSG91_OTP_VARIABLE` (default `OTP`), `MSG91_TEMPLATE_VARIABLES`, `MSG91_NOTICE_TEMPLATE_ID` (show-cancellation SMS) and `MSG91_NOTICE_TEMPLATE_VARIABLES`.

These switches are read on the server only. Nothing in a request (body, query string, cookie, local storage) can change them (automated test).

### Behaviour matrix (automated test: `tests/integration-flag-matrix.test.ts`)

| `ALLOW_PUBLIC_SALES` | Sales settings | Mobile | Email-only checkout | Mobile sign-in | Health `config / publicSales / mobile` | Staff sign-in |
|---|---|---|---|---|---|---|
| `false` | valid | `false` | blocked | refused | true / false / false | works |
| `false` | valid | `true` + MSG91 | blocked | works (sign-in is not a sale) | true / false / true | works |
| `true` | valid | `false` | **works** | refused | true / true / false | works |
| `true` | valid | `true` + MSG91 | works | works | true / true / true | works |
| `true` | valid | `true`, MSG91 missing | works | refused | true / true / false | works |
| `true` | email missing | `false` | blocked | refused | false / false / false | works |
| `true` | Razorpay live key on staging | `false` | blocked | refused | false / false / false | works |
| missing | valid | `false` | blocked | refused | true / false / false | works |
| `TRUE` / `yes` | valid | `1` / `on` | blocked | refused | true / false / false | works |

Note: customer sign-in itself depends only on the sales settings, not on `ALLOW_PUBLIC_SALES`, so customers can sign in and see their tickets while sales are paused.

Where to set these for a deployed Worker: as variables/secrets of the Cloudflare Worker `ganabhawan-festival` (dashboard, or `npm run deploy:secrets` with an env file). `.env.example` and `wrangler.jsonc` do not configure the deployed Worker; no GitHub workflow sets them.

## 4. Customer journey (new customer, email only, mobile off)

Pages are Next.js routes under `app/`.

1. **Browse** – `/` (home) links to `/catalogue`, which lists published shows, daily tickets per zone (Premier, Superior, Balcony) and season tickets, with live availability (`GET /api/catalogue`). Reviewed.
2. **Choose tickets** – add lines to the cart (`/cart`). A signed-out visitor's cart lives in the browser; a signed-in customer's cart is stored on the server (`GET/PUT /api/cart`). A single item can also be bought directly from `/book/[productId]`. Carts never reserve inventory. Automated test (cart suites).
3. **Checkout** – `/cart/checkout`. If not signed in, the page sends the customer to `/login?next=/cart/checkout`. Reviewed.
4. **Sign in** – `/login` offers "Continue with Google" (Clerk; only a verified Google email is accepted) or a sign-in code. With mobile off the field asks for an email address. `POST /api/auth/otp/request` emails a 6-digit code ("Your code is … It expires in 5 minutes"). `POST /api/auth/otp/verify` checks it and creates a session (HttpOnly `festival_session` cookie, 12 hours). A new email creates the account; a known email signs in to the existing account. Automated test.
5. **Cart merge** – after sign-in the browser cart merges once into the account cart (`POST /api/cart/merge`). Automated test.
6. **Hold** – "Pay" creates one checkout for the whole cart (`POST /api/checkouts`): server-side price, contact rule (a verified email is required while mobile is off; `CONTACT_REQUIRED` otherwise), availability, then an inventory hold for each line. The hold expires after the festival's hold time (default 10 minutes, 1–30). Automated test.
7. **Payment order** – `POST /api/payments/order` creates one Razorpay order for the checkout total computed on the server. Automated test (fake Razorpay).
8. **Pay** – the Razorpay Checkout modal opens in the browser. Not verified with real Razorpay.
9. **Verify** – the browser posts the payment result to `POST /api/payments/confirm`; the server checks the Razorpay signature AND fetches the payment from Razorpay (amount, order, captured state). The Razorpay webhook (`POST /api/payments/webhook/razorpay`, signature-checked) and the background reconciliation can confirm the same payment; whichever arrives first wins and the rest are no-ops. Automated test.
10. **Confirm** – in one transaction: bookings become `CONFIRMED`, one ticket per seat is issued with its own encrypted QR credential, and a `DELIVERY` job is queued. The browser goes to `/receipts/[checkoutId]`. Automated test.
11. **Email** – the next background tick sends one consolidated confirmation email (section 9). Automated test (fake Resend); real inbox delivery not verified.
12. **Open the link** – the email links to `/tickets/[bookingId]` (one booking) or `/tickets` (several). Signed out → `/login?next=/tickets/...`, then back. Only the owner's bookings are shown; another account gets "not found". Ownership: automated test. Redirect: reviewed.
13. **Show the QR** – each ticket's QR image comes from `GET /api/tickets/[id]/pass` (owner only, active tickets only); a PDF from `GET /api/tickets/[id]/pdf`. Automated test (QR data URL for owner; refusal for others).
14. **Admission** – gate staff scan at `/gate` (`POST /api/admission/scan`). First scan `ADMITTED`; any later scan of the same ticket `DENIED` (`DUPLICATE`). Automated test.

## 5. Existing-customer journey

| Step | Behaviour | Status |
|---|---|---|
| Sign in | Same `/login` code or Google; the same email always reaches the same account (no duplicates) | Automated test |
| Page refresh | The session cookie is sent again; `GET /api/auth/me` restores the user | Reviewed |
| Bookings | `/tickets` lists all of the account's bookings; `/tickets/[id]` one booking; `/receipts/[id]` one checkout | Automated test (ownership) |
| New purchase | Same as section 4 | Automated test |
| Resend | `POST /api/tickets/[id]/resend` (owner, 3 per hour) re-sends the confirmation to the verified email | Automated test (function); rate limit reviewed |
| Sign out | `POST /api/auth/logout` deletes the session row | Automated test |
| Session expiry | After 12 hours the session no longer authenticates | Automated test |
| Sign in again | Bookings are still there (they belong to the account, not the session) | Automated test |

## 6. Mobile features off (`MOBILE_PHONE_NUMBER_ENABLED=false`, the current launch setting)

| Situation | What happens | Status |
|---|---|---|
| Email customer | Signs in, buys, receives email; nothing changes | Automated test |
| Mobile number typed at `/login` | `MOBILE_DISABLED`: "Sign-in with a mobile number is not available yet. Please use your email address." Same answer for every number; no code stored or sent | Automated test |
| Mobile code issued before the switch-off | Refused at verification; no session | Automated test |
| "Add a mobile" | Hidden in the UI; `POST/PUT /api/account/mobile` refused | Automated test |
| Email account that already has a verified mobile | Gets email only; the mobile is kept, unused | Automated test |
| SMS jobs queued earlier | Parked on first run (`FAILED`, `SMS_DISABLED: …`), not recorded as delivered, not retried, not resent automatically when mobile is turned on | Automated test |
| Show-cancellation notice to a mobile-only account | Parked the same way (no SMS) | Automated test |
| Any SMS gateway call (MSG91, httpSMS, webhook) | None | Automated test |

### Impact on existing mobile-only customers (needs a decision before production)

An account whose only contact is a mobile number **cannot sign in while mobile features are off**, and cannot buy (`CONTACT_REQUIRED`). Its account, bookings, tickets and QR credentials are kept unchanged; the gate still admits a valid QR if the customer can show it (for example a QR page saved earlier). There is no built-in way for such a customer to add an email address or move to an email account. "Resend tickets" for such a booking fails with "SMS is not available".

How many such customers exist was **not checked** (production data was not accessed). An operator can count them read-only:

```sql
SELECT count(*) FROM users u
WHERE u.role = 'customer' AND u.contact NOT LIKE '%@%'
  AND EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = u.id AND b.status = 'CONFIRMED');
```

If the count is not zero, plan how they will reach their tickets (turn mobile on first, or contact them) before switching production to email-only.

## 7. Mobile features on (`MOBILE_PHONE_NUMBER_ENABLED=true` with complete MSG91 settings)

* Mobile sign-in: the app generates the 6-digit code, stores only a keyed hash, and sends it with the MSG91 Flow API using the OTP template (`MSG91_OTP_TEMPLATE_ID`, variable `MSG91_OTP_VARIABLE`). Same limits as email codes. MSG91's own OTP verification is not used. Automated test (fake MSG91).
* A mobile verified on an email account signs in to that same account. Automated test.
* Checkout: email-only, mobile-only and email + mobile accounts may buy.
* Confirmation SMS: a separate `NOTIFY` job sends the confirmation template (`MSG91_TEMPLATE_ID`) with `REFERENCE`, `SHOW`, `LINK`. The physical-card sentence must be fixed text in the DLT-approved template; the app only fills variables. Automated test (fake MSG91).
* Show-cancellation SMS needs `MSG91_NOTICE_TEMPLATE_ID`; without it that notice job fails visibly after its retries. Automated test.
* Provider failure: an MSG91 reply other than `type: "success"` is an error; the customer sees "SMS delivery is temporarily unavailable"; logs carry only the HTTP status and a digit-redacted provider message. Automated test.
* httpSMS and the generic webhook are never used outside local development. Automated test.
* **Not verified:** real MSG91 account, DLT registration, templates, sender header, variable names, real delivery.

## 8. Payment and booking lifecycle

Booking (`bookings.status`): `HELD` → `PAYMENT_PENDING` → `CONFIRMED`; or `EXPIRED` (hold lapsed), `CANCELLED` (show cancelled / superseded), `REFUND_REQUIRED` → `REFUNDED` (money that cannot be honoured).

Checkout status (derived from its bookings): `HELD`, `PAYMENT_PENDING`, `CONFIRMED`, `PARTIALLY_CANCELLED` (one line's show cancelled after payment), `REFUND_REQUIRED`, `REFUNDED`, `CANCELLED`, `EXPIRED`.

Payment attempt: `CREATING` → `READY` (order exists) or `UNCERTAIN`/`FAILED`. Payment: `AUTHORIZED`, `CAPTURED`, `FAILED`. Refund: `REQUESTED` → `PROCESSING` → `SUCCEEDED` or `FAILED`.

Rules (all automated test):

* A booking becomes `CONFIRMED` only when a captured payment of the exact server amount is verified (signature + provider fetch, signed webhook, or reconciliation).
* Tickets and QR credentials are created in the same transaction as the confirmation, never on notification retries.
* All lines of a checkout confirm together. A payment that arrives after a line sold out or expired confirms nothing and is refunded in full.
* Duplicate webhooks (even concurrent), a webhook before or after the browser callback, and reconciliation all settle a payment once.
* Customers cannot cancel or refund. Refunds happen only on show cancellation or unfulfillable late payments.

## 9. Notification lifecycle

| Email | Trigger | Content | Idempotency | Status |
|---|---|---|---|---|
| Sign-in code | `POST /api/auth/otp/request` | 6-digit code, 5-minute expiry | One code per request; 30 s apart, 5/hour per contact, 30/hour per IP | Automated test |
| Checkout confirmation | `DELIVERY` job after a confirmed checkout | Opening line with "Please collect your physical cards before the show.", ticket link, order and payment reference, each line (zone, ticket type, performances in IST, quantity × price), total, refunds, receipt link | Job key `checkout:<id>` sent as Resend `Idempotency-Key`, plus a `notification_deliveries` record | Automated test |
| Single-booking confirmation | `DELIVERY` job after a confirmed `/book` purchase | Same opening, booking QR link, booking details | Job key + record | Automated test |
| Resend tickets | `POST /api/tickets/[id]/resend` | The single-booking confirmation again | Deliberate re-send; 3/hour | Automated test |
| Show-cancellation notice | `NOTICE` job when an owner cancels a show | "A performance you booked was cancelled. Your tickets are void and a full refund has been started…" (or the unpaid-hold variant) | Job key `cancel-booking:<show>:<booking>` as `Idempotency-Key` (fixed in this branch) | Automated test |

There are no refund-status, failed-payment, account or staff emails in the code base. Emails are English only (the site UI is English/Bengali).

Delivery mechanics:

* Nothing is sent inside the payment request; the background tick (every minute) sends.
* Email and SMS are separate jobs: a failure in one never blocks the other.
* A failed send retries with backoff (2, 4, 8, 16 minutes), then the job is `FAILED` with an `[alert]` log line and counted by `GET /api/ops/status`.
* A notification failure never changes payments, bookings or tickets.
* Residual risk: if the provider accepts a message and the job's database update then fails, a retry can send the SMS again (MSG91 has no idempotency key). Email is protected by Resend's Idempotency-Key (24 hours); Composio Gmail, if used instead, has no such key.

Operational recovery: find jobs with `state='FAILED'` (ops status or SQL), fix the cause, then `UPDATE jobs SET state='PENDING', run_at=now(), attempts=0 WHERE id=…`.

## 10. Ticket and QR lifecycle

* Each seat is a `tickets` row with its own `credentials` row (an encrypted random token). The QR encodes that token. Retries never change it (automated test).
* Ticket pages and QR images are owner-only (server-side ownership check); booking, ticket and checkout IDs are random UUIDs. Unknown or malformed IDs are refused (automated test).
* Scanning (`POST /api/admission/scan`, roles scanner/supervisor, and owner): the scanner must be scoped to the show, gate and device. Results: `ADMITTED`; `DENIED` with a code such as `DUPLICATE`, `WRONG_SHOW`, `TICKET_INACTIVE`, `OUTSIDE_WINDOW`, `SHOW_NOT_OPEN`, `NOT_SCOPED`, `DEVICE_REVOKED`; `UNKNOWN` (`UNKNOWN_CREDENTIAL`) for an unrecognised code. Every scan is logged in `scan_requests`. Automated test.
* Show cancellation voids the tickets; the gate refuses them afterwards (automated test).

## 11. Staff and admin journey

* Admin door `/admin/login` (owner, inventory, finance, desk) and gate door `/gate/login` (scanner, supervisor): email or username + password (`POST /api/auth/password`), rate-limited, 12-hour session. The wrong door is refused with `WRONG_PORTAL`. Automated test.
* Dashboard `/admin`: catalogue and shows (owner, inventory), inventory (owner, inventory), staff accounts (owner), metrics (owner, inventory, finance), reconciliation cases (finance). Enforced on the server for every admin API. Automated test.
* Staff access depends only on core settings and roles: it works while customer sales are not configured or paused, and with mobile features off. Automated test.
* The Expo app in `mobile/` has a gate staff sign-in using the same API (contract test only; not run on a device).

## 12. Error and recovery scenarios

| Scenario | Behaviour | Status |
|---|---|---|
| Wrong code | "The code is incorrect"; max 5 attempts per code | Automated test |
| Expired / reused code | "This code has expired or is no longer valid"; no session | Automated test |
| Too many requests | HTTP 429 "Too many attempts" / "Please wait 30 seconds" | Automated test |
| Email provider down at sign-in | Error shown; never "code sent" | Automated test |
| Email provider down after payment | Booking stays confirmed; email retried | Automated test |
| SMS provider down (mobile on) | Booking stays confirmed; SMS retried alone | Automated test |
| Payment dismissed or failed | Nothing confirmed; the hold expires; retry works | Automated test |
| Forged signature / wrong amount / other user | Refused; nothing confirmed | Automated test |
| Last ticket raced by many buyers | Exactly one hold wins; inventory never negative | Automated test |
| Hold expired before payment | Old order refused; a new checkout gets a new hold; a late payment is refunded | Automated test |
| Duplicate webhook | Settled once | Automated test |
| Missing configuration | 503 `CONFIG_INVALID` for customer APIs; staff unaffected unless core is broken | Automated test |
| Someone else's ticket | Not found / access denied | Automated test |
| Duplicate QR scan | `DENIED` / `DUPLICATE` | Automated test |

## 13. API and route reference (confirmed in `app/`)

| Group | Routes |
|---|---|
| Pages | `/`, `/catalogue`, `/book/[productId]`, `/cart`, `/cart/checkout`, `/login`, `/sign-in`, `/sign-up`, `/sso-callback`, `/tickets`, `/tickets/[id]`, `/receipts/[id]`, `/admin/login`, `/admin`, `/admin/accounts`, `/gate/login`, `/gate` |
| Customer auth | `GET/POST /api/auth/otp/request`, `POST /api/auth/otp/verify`, `POST /api/auth/clerk/sync`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST/PUT /api/account/mobile` |
| Catalogue and cart | `GET /api/catalogue`, `GET /api/catalogue/search`, `POST /api/catalogue/search/reindex`, `GET/PUT /api/cart`, `POST /api/cart/merge`, `GET /api/posters/[id]` |
| Checkout and payment | `POST /api/checkouts`, `GET /api/checkouts/[id]`, `POST /api/holds`, `POST /api/booking-attempts`, `POST /api/payments/order`, `POST /api/payments/confirm`, `POST /api/payments/sync`, `POST /api/payments/webhook/razorpay` |
| Tickets | `GET /api/bookings`, `GET /api/bookings/[id]`, `GET /api/tickets/[id]/pass`, `GET /api/tickets/[id]/pdf`, `POST /api/tickets/[id]/resend` |
| Staff and admin | `POST /api/auth/password`, `GET /api/admin/me`, `/api/admin/festival`, `/api/admin/shows`, `/api/admin/shows/[id]`, `/api/admin/products`, `/api/admin/products/[id]`, `/api/admin/products/[id]/coverage`, `/api/admin/inventory`, `/api/admin/staff`, `/api/admin/staff/[id]`, `/api/admin/metrics`, `/api/admin/ledger`, `/api/admin/cases/[id]`, `/api/admin/upload`, `POST /api/admission/scan` |
| Background and health | `POST /api/cron/worker` (CRON_SECRET), `GET /api/ops/status`, `GET /api/health` |

## 14. Test coverage map

Run with `npm test` against the local database (`npm run db:local`).

| Journey | Test files |
|---|---|
| Flag × readiness matrix, health fields | `integration-flag-matrix.test.ts`, `health-route.test.ts`, `booking-fixes.test.ts` |
| Email-only journey, mobile off, parked SMS | `integration-mobile-flag.test.ts` |
| Every email type | `integration-email-types.test.ts` |
| MSG91 sign-in and SMS (mobile on), contact rules | `integration-msg91-contacts.test.ts` |
| Staff access vs sales readiness | `integration-staff-vs-sales-readiness.test.ts` |
| Checkout, payment, webhooks, reconciliation | `integration-checkout.test.ts`, `integration-payments.test.ts`, `integration-webhook-route.test.ts`, `integration-cart-retry.test.ts`, `integration-staging-issues.test.ts`, `razorpay*.test.ts` |
| Holds and inventory races | `integration-holds.test.ts`, `commerce-holds.test.ts` |
| Confirmation, notifications, retries | `integration-post-payment.test.ts`, `integration-admin-platform.test.ts` |
| Cancellation and refunds | `integration-cancel-refund.test.ts` |
| Gate, staff, jobs | `integration-staff-gate-jobs.test.ts`, `integration-admin-platform.test.ts` |
| Carts | `integration-account-cart.test.ts`, `cart-reconcile.test.ts` |
| Worker subrequest budget | `integration-worker-budget.test.ts` |

## 15. Known limitations and operational checklists

### Verified vs not verified

* **Automated test:** everything marked so above, with fake providers on a local database.
* **Not verified:** real Razorpay test-mode checkout in a browser, real Resend delivery to an inbox, real MSG91 (account, DLT, templates, delivery), Google sign-in end to end, the Expo app on a device, behaviour on the deployed Worker.

### Known limitations

* No isolated staging: there is one Worker (`ganabhawan-festival`), deployed automatically from `main` after CI, serving the public URL with `DEPLOY_ENV=staging`. A merge to `main` is a deployment.
* Existing mobile-only customers cannot sign in while mobile features are off (section 6).
* Emails are English only.
* SMS can be duplicated in a narrow failure window (section 9).

### Staging checklist (before any staging deployment)

1. Create a separate staging Worker (its own name/route) and a deployment path that targets only it.
2. Point it at a staging database separate from production (check the host).
3. Razorpay **test** keys; webhook pointed at the staging URL with its own secret.
4. Resend with a verified sending domain; send to controlled test addresses only.
5. `MOBILE_PHONE_NUMBER_ENABLED=false` explicitly; MSG91 settings only when testing mobile, with controlled test numbers.
6. `ALLOW_PUBLIC_SALES=true` only on staging.
7. Confirm the staging cron cannot reach the production database.
8. Check `GET /api/health`: `db`, `schema`, `staff`, `config`, `publicSales` true; `mobile` false.
9. Run journeys A, B and C by hand (sections 4–6) with real test-mode providers, then the duplicate-scan check at `/gate`.

### Production checklist

1. Count mobile-only customers with confirmed bookings (section 6) and decide how they get their tickets.
2. Set production Worker settings: Razorpay **live** keys, `DEPLOY_ENV=production`, email delivery, `MOBILE_PHONE_NUMBER_ENABLED=false`, `ALLOW_PUBLIC_SALES` only when ready.
3. Apply database migrations with the documented host confirmation (never automatically).
4. Verify `GET /api/health` on production before opening sales.
5. Make one real low-value purchase and admit it at the gate; confirm the email arrived.
6. Later, to enable mobile: approved DLT templates, MSG91 settings, a test SMS to a controlled number, then `MOBILE_PHONE_NUMBER_ENABLED=true` last (docs/HANDOVER.md sections 7–8).
