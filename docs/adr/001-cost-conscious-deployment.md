# Cost conscious deployment

Status: implemented baseline for the user's 5 September 2026 request to avoid paid database services and Supabase.

Use one Next.js application with modular server services, route handlers and a separately runnable worker. This replaces the initial speculative Next.js/NestJS/pnpm multi-service layout and AWS requirement with one npm-managed application deployed through Vinext on Cloudflare Workers. Keep PostgreSQL transaction authority and SQL constraints unchanged. Use Drizzle schema definitions and reviewed SQL migrations over node-postgres connections.

Development uses a real local PostgreSQL server via embedded-postgres, without Docker or an external account. Hosted configuration accepts a Neon PostgreSQL pooled DATABASE_URL and direct migration URL. Do not automatically provision paid resources. Neon account authentication and live payment/delivery credentials are deferred until the user supplies them.

Use development-only payment and OTP adapters, explicit visible development labeling and fail-closed live configuration. Production must not allow development adapters or test staff bypass. Workers can run as a separate process or through a secret-protected scheduler endpoint. Durable database jobs provide retry and deduplication without a mandatory paid queue.

Free-tier cold starts, limits, backup retention and scheduler availability do not establish the PRD's production availability/recovery targets. Test the selected host and restore process before live admission. This decision reduces deployment cost, not the correctness requirements.
