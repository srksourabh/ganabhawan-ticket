# Operations runbook

URLs (replace with the production host): site `/`, programme `/catalogue`, customer tickets `/tickets`, staff sign-in `/admin/login`, admin `/admin`, money and operations `/admin/accounts`, gate `/gate`, health `/api/health`, monitor `/api/ops/status`.

## Daily operation

| Task | Where | Who |
|---|---|---|
| Create or edit a show, zones, prices | Admin → Dramas / Products | owner, inventory |
| Open or pause sales | Admin → Festival status + `ALLOW_PUBLIC_SALES` | owner |
| See bookings, payments, refunds, people who tried to book | Admin → Accounts | owner, finance |
| Operations health (critical items) | Admin → Accounts → Operations | owner, finance |
| Scan tickets | `/gate` (choose gate, show, then scan) | scanner, supervisor, owner |
| Add or remove staff (owners) | `ENV_FILE=.env.production npm run db:staff -- …` (GO_LIVE §4) | engineer with DB access |

## Cancelling a performance

Admin → Dramas → edit → Status **CANCELLED** → type the title to confirm. Owner only. This is final.
It immediately: voids every ticket (the gate refuses them), cancels the bookings, releases holds, starts a full refund for each payment, and emails each customer. Refund progress is shown in Accounts → Refunds.

* **Refused with "season booking(s) include this performance"**: partial season refunds are not supported until the refund policy (DECISIONS D14) is decided. Do not unpublish the show instead (that is also refused while tickets exist). Escalate to engineering and the committee.
* Postponing: edit the start time instead of cancelling; tickets stay valid.

## Incidents

| Symptom | What it means | Action |
|---|---|---|
| Customer: "I paid but have no ticket" | Usually a closed browser before confirmation | Ask for the booking reference or Razorpay payment id. Wait 2 minutes (reconciliation runs every tick). Check Accounts → Payments. Engineer: `npm run drill:razorpay -- <ref>` shows the full trail. If Razorpay shows it captured and the DB doesn't, an "unknown-order" case appears in Operations. Refund it from the Razorpay dashboard, then mark the case resolved with the refund id |
| Operations: "captured payment(s) not matched" | Money arrived for an order the system can't map | As above; never issue tickets manually |
| Operations: "refund(s) failed" | Razorpay could not refund (bank/UPI issue) | Razorpay dashboard → refund → retry or contact the customer for alternate details; resolve the case with a note |
| Refund pending > 7 days | Bank delay | Razorpay dashboard status; tell the customer the ARN; it updates automatically when processed |
| "Email not received" | Delivery failed or spam | Customer can always open My tickets (sign in with the same email or phone). Use resend from the ticket page (3 per hour). Failed deliveries appear in Operations |
| Gate scanner can't sign in | Wrong page, wrong password, or deactivated | Scanners use `/gate/login` (office staff `/admin/login`). Owner resets the password or re-adds the person in the dashboard Staff tab |
| Gate says "not authorized for this show" | Staff has no scope for that show or gate | `npm run db:staff -- scopes <email>` |
| Gate says "outside the allowed time window" | Earlier than `entry_before` / later than `entry_after` minutes (Admin → Festival) | Supervisor decides on manual entry; adjust the festival entry window if policy allows |
| Gate scanner offline / device broken | — | Use another phone with `/gate`; any scoped scanner works on either gate. Last resort: owner account on a supervised device |
| Razorpay down | Order creation fails; holds remain | Customers retry; holds expire safely after 10 min. Nothing to reconcile |
| `/api/health` 503 `config:false` | Live configuration incomplete | Worker logs show `[config] refusing to serve; missing or unsafe: …` with the names. Fix the secrets and redeploy |
| `/api/ops/status` 503 "worker is behind" | Cron not firing, or ticks failing | Cloudflare → Worker → Cron Events / logs (`[cron] tick` lines; a 500 body lists the failed steps). Run one tick manually: GitHub Actions → Hold expiry cron (workflow_dispatch) |

## Secrets

Names only, never values, in tickets or chat. Rotate `SESSION_SECRET` (signs everyone out) and `CRON_SECRET`/`OPS_MONITOR_TOKEN` (update GitHub and the monitor) freely. `CREDENTIAL_KEY` encrypts QR tokens and staff MFA secrets: rotating it invalidates every issued ticket QR and every authenticator. Only do so if it leaked, before sales, then re-enrol staff.

## Backups

Before every deploy that runs a migration: Neon console → create a branch `pre-<git sha>` from production (point-in-time, instant). Neon also keeps point-in-time restore history (check the plan's retention window).

## Rollback

| Item | Value |
|---|---|
| Who | owner + the engineer on call |
| When | health 503 after deploy, checkout or gate failing in smoke tests, money invariant FAIL in `drill:razorpay` |
| App rollback | 1. Run `UPDATE bookings SET status='REFUND_REQUIRED' WHERE status='REFUNDED';` (data-preserving: the old version doesn't know REFUNDED and would otherwise issue tickets for a later payment on such a booking instead of refunding it). 2. Cloudflare dashboard → Workers → ganabhawan-festival → Deployments → previous version → "Rollback" (or `npx wrangler rollback`). Migration 0006 is otherwise additive and the previous version runs on it (verified: old code books and confirms on the 0006 schema) |
| Schema rollback | Only if the schema itself is at fault: restore the `pre-<sha>` Neon branch, **or** run `db/rollback/0006_down.sql` (maps REFUNDED back to REFUND_REQUIRED, drops the added columns; staff enrolled via `db:staff` keep their `mfa_secret`) |
| Verify | `/api/health` 200, `/api/ops/status` 200, `npm run drill:razorpay` all PASS, one scan of a known ticket at `/gate` |
