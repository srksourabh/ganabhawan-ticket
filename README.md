# Samatat Natyomela 2026 — festival ticketing

Private repository for **Samatat Sanskriti** ticket sales at **Ganabhawan, Uttarpara**.  
Festival window: **19–30 December 2026** (12 plays, tentative programme).

## Production snapshot

| Item | Value |
| --- | --- |
| **Hosting** | Cloudflare Workers via [Vinext](https://github.com/cloudflare/vinext) |
| **Production URL** | https://ganabhawan-festival.srksourabh.workers.dev |
| **Health** | https://ganabhawan-festival.srksourabh.workers.dev/api/health |
| **Database** | Neon Postgres (`samatat`), region `aws-ap-southeast-1` |
| **Auth** | Clerk (Google) + OTP session + admin email/password |
| **Payments** | Development adapter locally; Razorpay Checkout wired for sandbox/live |
| **Search** | PostgreSQL text fallback; optional Chroma when `CHROMA_URL` is set |
| **Jobs** | `POST /api/cron/worker` (GitHub Actions every 2 minutes + manual) |
| **Repo visibility** | Private (`srksourabh/ganabhawan-ticket`) |

Keep `ALLOW_PUBLIC_SALES=false` and `APP_MODE=development` until committee decisions D10–D16 in [docs/DECISIONS.md](docs/DECISIONS.md) are signed off.

## Features

- Bilingual (Bengali / English) public site and programme
- Daily tickets by auditorium zone (Premier / Superior / Balcony) via interactive hall map
- Season passes per zone covering the festival programme
- Cart checkout with holds, Razorpay Checkout (or development confirm)
- Ticket PDFs with QR; My tickets; staff gate scan at `/gate`
- Admin panel: festival settings, dramas/posters, prices, zone reference (`/admin`)
- Inventory pools with atomic holds; hold expiry via cron worker

## Local development

```powershell
npm install
npm run setup          # writes .env.local with APP_MODE=development
npm run db:local       # embedded Postgres if used
npm run db:migrate
npm run db:seed        # Samatat Natyomela 2026 programme (DEV ONLY — truncates bookings)
npm run db:admin       # set admin from ADMIN_* env
npm run dev
```

Verification:

```powershell
npm run typecheck
npm run lint
npm test
npm run check
```

**Never** run `npm run db:seed` against Neon while `APP_MODE=development` unless you intend to wipe bookings and rebuild the programme.

## Deploy (Cloudflare + Neon)

```powershell
# secrets from .env.local → Worker
npm run deploy:secrets

npm run build:vinext
npm run deploy:vinext
```

Confirm health returns `{"ok":true,"db":true}`.

GitHub Actions secrets for hold expiry:

| Secret | Example |
| --- | --- |
| `CRON_SECRET` | same as Worker `CRON_SECRET` |
| `APP_URL` | `https://ganabhawan-festival.srksourabh.workers.dev` |

## Environment (see `.env.example`)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon pooled URL (runtime) |
| `DIRECT_DATABASE_URL` | Neon direct URL (migrations) |
| `APP_MODE` | `development` or `live` |
| `ALLOW_PUBLIC_SALES` | must be `true` for paid public holds outside development |
| `PAYMENT_PROVIDER` | `development` or `razorpay` |
| `RAZORPAY_*` | key id/secret/webhook when using Razorpay |
| `OTP_PROVIDER` | `development`, email, or SMS providers |
| `CRON_SECRET` | authorizes `/api/cron/worker` |
| `FESTIVAL_CONTACT_EMAIL` | public contact used by seed (default `tickets@samatat.org`) |
| Clerk keys | Google sign-in |

## Docs

| Document | Purpose |
| --- | --- |
| [docs/GO_LIVE.md](docs/GO_LIVE.md) | Operator go-live checklist |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | What is verified vs gated |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Commercial / venue decisions (D01–D22) |
| [docs/TASKS.md](docs/TASKS.md) | Historical PRD task list (monolith already shipped) |
| [docs/DATABASE_PLAN.md](docs/DATABASE_PLAN.md) | Schema and locking intent |

## Product rules

- Sell a **section**, never a numbered seat
- One ticket = one person
- Daily = one performance; Season = explicit covered list
- Confirm only after verified captured payment
- Admit each ticket at most once per included performance
- PostgreSQL is authoritative for stock, money, tickets, and admission
