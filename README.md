# Samatat Sanskriti ticketing (venue: Ganabhawan)

This repository contains the supplied Theater Festival Ticketing System PRD, implementation plans and the current application for section-based festival ticketing for **Samatat Sanskriti**, presented at **Ganabhawan** (venue name is configurable). See [implementation status](docs/IMPLEMENTATION_STATUS.md) for verified work and remaining launch gates.

## Documents

| Document | Purpose |
| --- | --- |
| [Step by step task list](docs/TASKS.md) | Ordered implementation checklist with dependencies and completion criteria; start here |
| [Frontend plan](docs/FRONTEND_PLAN.md) | Public booking, customer tickets, administration, ticket desk and gate scanner |
| [Backend plan](docs/BACKEND_PLAN.md) | Domain services, APIs, payments, admission transactions and workers |
| [Database plan](docs/DATABASE_PLAN.md) | Entities, constraints, locking, migrations, reconciliation and recovery |
| [Implementation roadmap](docs/IMPLEMENTATION_PLAN.md) | Build sequence, dependencies, PRD acceptance coverage and launch gates |
| [Decision register](docs/DECISIONS.md) | Proposed defaults, unresolved policies and responsible approvers |
| [Implementation status](docs/IMPLEMENTATION_STATUS.md) | Verified foundation work and remaining launch-gated work |

Read the decision register before configuring a real festival. Build the database integrity rules and shared API contracts before integrating checkout and admission screens.

## Source and interpretation

- [Original PRD in Word](Uttarpara_Ganafubon_Ticketing_PRD.docx)
- [Supplied PRD in PDF](Uttarpara_Ganafubon_Ticketing_PRD.pdf)

The plans were derived from the Word PRD's text and tables. PRD requirement IDs such as INV02, PAY03 and AC15 are retained for traceability. Technical details beyond that text are proposed implementation designs, not additional approved commercial requirements. Provider contracts, supported software versions, hosting prices and launch-date legal applicability must be checked during implementation; these plans do not independently validate them.

## Product rules

- Sell a section, never a numbered seat. Seating is first come, first served within the purchased allocation.
- One ticket represents one person. Quantity three creates three independently usable tickets.
- Daily provisionally covers one performance. Season covers an explicit, versioned performance list.
- Reserve every covered performance atomically. PostgreSQL controls stock and admission.
- Confirm only after verified captured payment. Late capture either reacquires capacity or creates a tracked refund case.
- Admit each ticket at most once per included performance. Exchange and replacement preserve admission history.
- Offline or uncertain scans never authorize entry. Sales pause does not invalidate confirmed tickets.

## Proposed structure

The current implementation uses one Next.js/React/TypeScript application, Vinext on Cloudflare Workers, route handlers and separately runnable Node workers, with PostgreSQL via node-postgres/Drizzle plus reviewed SQL migrations. Chroma provides semantic catalogue retrieval only. The AWS/RDS/SQS/S3/KMS stack remains a PRD proposal and is not assumed by the current deployment.

```text
apps/
  web/                     # Public, customer and staff interfaces
  api/src/modules/         # Modular monolith and transaction boundary
  worker/src/jobs/         # Expiry, reconciliation, PDF and delivery jobs
packages/
  database/                # Prisma schema, migrations and reviewed SQL
  contracts/               # OpenAPI, schemas and generated types
  ui/                      # Shared accessible components
config/
observability/
tests/{unit,integration,e2e,concurrency,load}/
infra/terraform/{modules,environments}/
docs/{adr,runbooks,policies,zone-survey}/
.github/workflows/
```

This tree is a planned implementation layout. Only planning documents are created at this stage. The existing `graft/` directory is not application source.

## Catalogue search

Catalogue search uses a Chroma server for bilingual semantic retrieval. Start Chroma locally (for example, `chroma run --host 127.0.0.1 --port 8000`), set `CHROMA_URL`, and reindex published catalogue data with `POST /api/catalogue/search/reindex` using `Authorization: Bearer <CRON_SECRET>`. Search is available at `GET /api/catalogue/search?q=tagore&limit=8`. PostgreSQL remains authoritative for publication, prices and availability; Chroma stores searchable text and result metadata only.
