# Operator checklist — Cloudflare + Neon go-live

Do these on your machine (interactive login). The agent cannot complete OAuth from this environment.

## 1. Cloudflare account

**Option A — claim the temporary Worker (if still within the claim window)**  
Open the claim URL printed at deploy time, then continue with secrets below.

**Option B — permanent account**

```powershell
cd C:\Projects\Ganabhawan-Ticket
npx wrangler login
```

Or create an API token (Workers Scripts Edit + Account Settings Read) and set:

```powershell
$env:CLOUDFLARE_API_TOKEN = "…"
$env:CLOUDFLARE_ACCOUNT_ID = "…"
```

In Cursor Desktop, authenticate the **Cloudflare** MCP plugins when prompted.

## 2. Neon Postgres → migrate → secrets → redeploy

1. Create a Neon project (or auth Neon MCP in Cursor Desktop).
2. Copy the **pooled** connection string and the **direct** (non-pooler) URL.
3. Put them in `.env.local`:

```env
DATABASE_URL=postgresql://…@….neon.tech/neondb?sslmode=require
DIRECT_DATABASE_URL=postgresql://…@….neon.tech/neondb?sslmode=require
APP_URL=https://<your-worker>.workers.dev
APP_MODE=development
ALLOW_PUBLIC_SALES=false
PAYMENT_PROVIDER=development
OTP_PROVIDER=development
```

4. Apply schema and synthetic data (development only):

```powershell
npm run db:migrate
npm run db:seed
```

5. Build, push secrets, deploy:

```powershell
npm run build:vinext
npm run deploy:secrets
npm run deploy:vinext
```

6. Confirm: `https://<worker>/api/health` should return `{"ok":true,"db":true}`.

Optional later: create a Cloudflare **Hyperdrive** config for the pooled URL and bind it in `wrangler.jsonc`.

## 3. Live payments / OTP + decisions

Until finance/committee decide, keep `PAYMENT_PROVIDER=development` and `OTP_PROVIDER=development`.

For sandbox/live checkout, set in `.env.local` then re-run `npm run deploy:secrets`:

| Variable | Source |
| --- | --- |
| `PAYMENT_PROVIDER=razorpay` | after sandbox works |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | Razorpay dashboard |
| `OTP_PROVIDER` + `RESEND_API_KEY` / `EMAIL_FROM` (and/or SMS_*) | delivery provider |
| `ALLOW_PUBLIC_SALES=true` | only after D10–D16 allow publication |
| `APP_MODE=live` | only with real providers (dev adapters are refused) |

Track commercial/ops open items in [DECISIONS.md](DECISIONS.md). Highest blockers for paid public sales: **D10, D13, D14, D16**. Branding default **D01** is recorded as Samatat Sanskriti / venue Ganabhawan.
