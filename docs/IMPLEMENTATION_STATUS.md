# Implementation status

This status is the working companion to the plans in this folder. The repository contains a runnable Next.js application deployed through Vinext to Cloudflare Workers. PostgreSQL remains the transactional authority and Chroma is used only for catalogue retrieval.

## Completed foundation

- Responsive Ganabhawan landing and programme screens, with visible loading and error states.
- Catalogue and Chroma search route handlers, protected catalogue reindexing, and local Worker smoke coverage.
- PostgreSQL migration, embedded local PostgreSQL setup, synthetic seed data, session/OTP services, catalogue queries, hold expiry, inventory adjustment, hold reservation and captured-payment fulfillment services.
- Vinext/Cloudflare build configuration and reproducible `npm run check` validation.

## Completed this session (development adapters)

Verified by `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build:vinext` on 6 Sep 2026.

| Area | Evidence |
| --- | --- |
| Auth HTTP | `POST /api/auth/otp/request`, `POST /api/auth/otp/verify` (session cookie), `POST /api/auth/logout`, `GET /api/auth/me`; login UI at `/login` |
| Holds / booking | `POST /api/holds` with Idempotency-Key; booking UI at `/book/[productId]` |
| Payments | Development order/confirm adapters; Razorpay order + callback + webhook ingestion; `POST /api/payments/*` |
| Tickets | PDF generation (`pdf-lib` + QR), owner download/resend, My tickets pages |
| Jobs / worker | `src/lib/jobs.ts`, `scripts/worker.ts`, `POST /api/cron/worker` (CRON_SECRET) |
| Admission | Online `admit` service + `/api/admission/scan` + `/gate` staff stub |
| Health / CI | `GET /api/health`; `.github/workflows/ci.yml` |
| Layout | Shared nav shell in `app/layout.tsx` |

## Still pending / launch-gated

- Live Razorpay sandbox credentials and end-to-end capture tests (AC05–AC10) — Checkout UI is wired; set `PAYMENT_PROVIDER=razorpay` + keys then sandbox-test.
- Hold expiry cron: GitHub Actions workflow `cron-holds.yml` (set `CRON_SECRET` + `APP_URL` repo secrets).
- Full bilingual copy review (D22), physical desk exchange, refund self-service, reconciliation reports, concurrency/load drills.
- Commercial decisions in `DECISIONS.md` (D10–D16 block paid public sales).
- Optional: Cloudflare Hyperdrive; hosted Chroma (Postgres search fallback is live).

## Paid launch flip (do not enable until D10–D16 signed)

1. Razorpay sandbox capture verified end-to-end.
2. Real OTP/email delivery configured.
3. Capacities and prices approved in admin.
4. Then set `ALLOW_PUBLIC_SALES=true`, `PAYMENT_PROVIDER=razorpay`, `APP_MODE=live`, redeploy secrets.

## Alignment rules

1. Implement each task in `TASKS.md` in dependency order.
2. Update a task only when its stated completion check passes and record evidence here.
3. Keep PostgreSQL authoritative for stock, money, tickets and admission; Chroma must never authorize a purchase or entry.
4. Treat synthetic data and development adapters as local-only. Production launch remains blocked by unresolved decisions in `DECISIONS.md`.

## Cloudflare deploy checklist

**Production Worker (6 Sep 2026):** deployed to account `srksourabh@gmail.com`.

- Worker URL: https://ganabhawan-festival.srksourabh.workers.dev
- Health: `{"ok":true,"db":true}` against Neon database `samatat`
- Catalogue returns Samatat Sanskriti / Ganabhawan seed data with development payment/OTP adapters
- Secrets pushed via `npm run deploy:secrets` (DATABASE_URL, SESSION_SECRET, CREDENTIAL_KEY, CRON_SECRET, APP_*, PAYMENT_PROVIDER, OTP_PROVIDER, ALLOW_PUBLIC_SALES)

Still deferred: live Razorpay/OTP (D16), Hyperdrive optional hardening, Chroma hosted search, commercial decisions D10–D22.

## Change set — Oct 2026 review feedback (unverified, needs `npm run check` + reseed)

- Header logo shows the mask mark only (CSS crops the wordmark); hero title follows the selected locale (EN shows English first).
- Seed adds an October prologue (12 Oct 2026, title TBA, troupe Samatat): programme is 13 plays, December stats unchanged.
- Programme rail is chronological; each play shows its troupe; artwork field is honoured so uploaded files under `public/images/plays/` replace collage placeholders (or set `artwork` via admin upload).
- Season purchase moved to its own panel below the single-play picker; per-zone rows are Daily only.
- Auditorium map is a schematic SVG (stage + Premier/Superior/Balcony) with keyboard-accessible zone buttons and sold-out states; photo overlay removed.
- Nav: public sees Programme / Cart / My tickets; Gate and Admin links render for staff roles only (server APIs still enforce roles).
- Sale cutoff: backend already rejects post-curtain holds; UI now disables Add buttons and shows "Sales closed". Season closes at the first covered curtain.
- My tickets: coverage lists in chronological order; customer PDF buttons removed (PDF API kept for desk/staff); each ticket shows one QR card per covered play in date order with a save-to-Home-Screen hint.
- Interim QR model: per-show cards share the ticket's single credential; the gate already limits each code to one admission per show. Distinct permanent per-show codes need a credentials migration (follow-up).
- To apply: `npm run db:migrate && npm run db:seed && npm run check`, then redeploy + `npm run deploy:secrets`.
