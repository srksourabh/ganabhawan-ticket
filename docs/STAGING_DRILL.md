# Staging drill — real Razorpay test mode

Mandatory before production. Automated tests simulate Razorpay's HTTP API; only this drill proves the real checkout, signatures, webhooks and refunds against Razorpay.

**Setup:** staging Worker deployed per GO_LIVE.md with `DEPLOY_ENV=staging` and `rzp_test_` keys, its own Neon database migrated, an owner and a scanner enrolled (`db:staff`), one festival with two published shows (one starting within the next hour for gate tests), `ALLOW_PUBLIC_SALES=true`. Razorpay test-mode webhook pointed at the staging URL with all five events.

**Pre-flight: is staging running this commit?** A stale deployment reproduces bugs that are already fixed (e.g. "cart unusable after repeated cancel" and `/api/ops/status` 404 were both symptoms of a pre-`51a62c4` build).
* `GET /api/ops/status` **without** credentials must return **401**. A **404** means the deployed build predates the endpoint: rebuild and redeploy before continuing.
* `GET /api/health` must report `"mode":"live","env":"staging"`.
* `npx wrangler deployments list --name <staging worker name>` must show a deployment created after the commit you are testing. `wrangler.jsonc` names a single Worker (`ganabhawan-festival`); deploy staging under a **different** Worker name so a staging deploy can never replace production.
* Mobile OTP uses httpSMS, which relays through an Android gateway phone. Staging needs `OTP_PROVIDER=httpsms` (or both httpSMS keys), `HTTPSMS_API_KEY`, and `HTTPSMS_FROM` set to **the gateway phone's own number in +91… form**. The gateway phone must be online with the httpSMS app running and SMS credit. Worker logs show `httpsms accepted { id, status }` for each send; look that id up in the httpSMS dashboard if the SMS does not arrive.

Test cards and UPI are listed at https://razorpay.com/docs/payments/payments/test-card-upi-details/ (success card, failure card, `success@razorpay` / `failure@razorpay` UPI).

After **every** step run `ENV_FILE=.env.staging npm run drill:razorpay -- <booking ref>`. It is read-only and must show all PASS. Record: date, tester, booking reference, Razorpay payment/refund id, result.

| # | Scenario | How | Expected | Evidence |
|---|---|---|---|---|
| 1 | Health | `GET /api/health`, `GET /api/ops/status` (bearer) | 200 / 200, `mode:live`, `env:staging` | |
| 2 | Successful payment | Customer OTP sign-in → add 2 tickets → checkout → success card | "Booking confirmed", My tickets shows 2 QR codes, email arrives with a `/tickets/<booking id>` link that opens the booking | |
| 3 | Payment failure | Failure card | Error shown, no booking confirmed, hold expires after 10 min, availability restored | |
| 4 | Cancelled checkout | Close the Razorpay modal | "Payment cancelled"; retry within 10 min reuses the same hold and order | |
| 5 | Browser closed after paying | Pay, close the tab before the success screen | Webhook confirms within seconds; My tickets shows it | |
| 6 | Webhook missing | Disable the webhook in the Razorpay dashboard, pay, close the tab | Cron reconciliation confirms within ~2 minutes; re-enable the webhook | |
| 7 | Delayed / duplicate webhook | Razorpay dashboard → Webhooks → resend the same event twice | No second payment row, no extra tickets (drill script PASS) | |
| 8 | Payment after hold expiry, seats left | Open checkout, wait > 10 min (hold expires), then pay | Booking confirmed (late capture accepted) | |
| 9 | Payment after hold expiry, sold out | Set allocation to 1, user A opens checkout and waits > 10 min, user B buys the last seat, then A pays | A sees "Payment received… refund started"; refund appears in Razorpay; booking becomes REFUNDED after Razorpay processes it | |
| 10 | Two tabs / double click | Two tabs, same product, Pay in both; or double-click Pay | One hold, one Razorpay order (drill: one READY attempt) | |
| 11 | Show cancellation | Owner cancels show 2 (type its title) with 2 paid bookings | Bookings CANCELLED, refunds created and processed in Razorpay, customers emailed, the gate DENIES the old QR | |
| 12 | Gate | Scanner signs in (password + authenticator) at `/gate`, scans a valid ticket, then scans it again, then scans a ticket for another show | ADMITTED, then "already admitted", then "No active entitlement" | |
| 13 | Staff MFA | Scanner signs in without a code / with an old code | Refused both times | |
| 14 | Logout | Sign out, then reuse the old session (browser back / saved bearer) | 401 | |
| 15 | Worker crash | Simulate a worker killed mid-job: take the id of a DONE delivery job from step 2 and run `UPDATE jobs SET state='RUNNING', locked_at=now() - interval '20 minutes' WHERE id='<job id>'`, then wait one cron tick | `/api/ops/status` shows the worker as stuck until the tick; the job is reclaimed and DONE again (the customer gets the email a second time, which is harmless); status back to 200 | |
| 16 | Email provider down | Temporarily set a wrong `RESEND_API_KEY` on staging, buy a ticket | Ticket visible in My tickets; delivery job retries, then shows in Operations as failed; restore the key, use "resend" | |

**Pass criteria:** every row matches; `drill:razorpay` shows all PASS including the Razorpay cross-check; `/api/ops/status` returns 200 at the end (resolve any test cases in Accounts → Operations).
