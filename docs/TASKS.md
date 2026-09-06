# Step by step implementation task list

Start with T01, then work down this list. The order follows the PRD and the existing [implementation roadmap](IMPLEMENTATION_PLAN.md). Each task names its dependencies, implementation output and completion check. Verified foundation work is recorded in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md); unchecked tasks remain incomplete until their stated evidence exists.

## How to use this checklist

- Complete the listed dependencies before starting a task. Dependencies are technical prerequisites, not a requirement to wait for unrelated commercial decisions.
- Use clearly labelled synthetic venue data and provider test credentials during development. Track outstanding production approvals in [DECISIONS.md](DECISIONS.md); they block public launch, not local scaffolding.
- Treat each task as a small branch or a group of focused changes. Record the commit/PR and verification evidence beside the task when checking it off.
- Add or update the relevant API contract, migration and meaningful tests in the same change as the behavior they describe.
- Never check off a task based only on its screen working if its completion check requires a database, provider or concurrency result.
- This checklist carries forward the PRD stack. Verify supported dependency versions and current provider contracts when implementing the relevant task.

## Phase 1 Establish a runnable project

### T01 Record development defaults and launch blockers

- [ ] Review [DECISIONS.md](DECISIONS.md), assign an owner to each open item and record development defaults without marking them commercially approved.

**Depends on:** None.  
**Output:** Updated decision register and a synthetic fixture specification covering multiple performances, six products, row mappings and sample prices. Include two performances on one date to test Season behavior.  
**Done when:** Daily/Season scope, holds, entry windows and exchange policy are explicitly configurable, and no illustrative venue capacity is treated as approved.

### T02 Create the workspace and pin the toolchain

- [ ] Initialize or inspect Git, add `.gitignore`, and create a pnpm workspace with `apps/web`, `apps/api`, `apps/worker`, `packages/database`, `packages/contracts` and `packages/ui`.

**Depends on:** T01.  
**Output:** Root `package.json`, `pnpm-workspace.yaml`, lockfile, pinned runtime/package-manager versions and shared TypeScript/lint/format configuration. Preserve supplied PRDs and documentation.  
**Done when:** A clean dependency install succeeds and workspace packages resolve without committed secrets or build output.

### T03 Add local services and environment validation

- [ ] Configure local PostgreSQL and test delivery/storage adapters; create `.env.example` and validate required environment variables at startup.

**Depends on:** T02.  
**Output:** Local service configuration, isolated test database and documented Windows/PowerShell setup commands. Test adapters must be unavailable in production configuration.  
**Done when:** A fresh checkout can start dependencies, connect to PostgreSQL and fail clearly on missing configuration without displaying secrets.

### T04 Start the web API and worker applications

- [ ] Scaffold the Next.js/Vinext web application, route-handler API and worker entry points, with liveness/readiness checks, graceful shutdown and request IDs.

**Depends on:** T03.  
**Output:** Runnable apps and root commands for development, build, lint, type checking and tests. Distinguish process liveness from database readiness.  
**Done when:** The web app renders, API readiness checks PostgreSQL, the worker starts/stops cleanly and all three build.

### T05 Establish continuous integration

- [ ] Add CI for locked dependency installation, linting, type checking, builds, secret/dependency scanning and tests backed by disposable PostgreSQL.

**Depends on:** T04.  
**Output:** `.github/workflows/ci.yml` and a documented local verification command set. Add migration checks as schema changes arrive.  
**Done when:** A clean CI run passes and a deliberate failing check prevents success.

### T06 Define shared API and transaction contracts

- [ ] Create versioned OpenAPI schemas for catalogue, identity, holds, bookings, payments, tickets, desk, gates, refunds and admin operations.

**Depends on:** T04.  
**Output:** `packages/contracts/openapi.yaml`, generated/shared types, status/result enums, error shapes and an ADR for lock ordering and idempotency scope. Use the [backend](BACKEND_PLAN.md) and [database](DATABASE_PLAN.md) plans as the baseline.  
**Done when:** Web/API can consume the same contracts; money, timestamps, request IDs, replay receipts and conflict behavior have one definition.

## Phase 2 Build identity catalogue and the interface foundation

### T07 Create foundation migrations

- [ ] Add venue/festival, policy, customer/contact, OTP/session, staff/role/device/scope and audit tables with indexes and required constraints.

**Depends on:** T03, T06.  
**Output:** Prisma schema, reviewed SQL migrations, synthetic seed command and separate runtime/migration permissions.  
**Done when:** Migrations apply from empty, seeds repeat safely and duplicate verified contact ownership is rejected by PostgreSQL.

### T08 Implement customer authentication

- [ ] Build OTP request/verify, secure sessions, logout, rate limits, contact verification and contact-linking/recovery contracts.

**Depends on:** T07.  
**Output:** Identity module with keyed OTP hashes, expiry, attempt limits, resend controls, CSRF protection and neutral responses.  
**Done when:** Valid proof creates a session, while replay/expiry/exhaustion fail; no unverified match merges accounts. Prove AC12.

### T09 Implement staff access and audit middleware

- [ ] Add individual staff authentication with MFA, roles, show/gate assignments, device revocation and redacted audit events.

**Depends on:** T07, T08.  
**Output:** Backend authorization guards and an owner-only path to manage staff permissions.  
**Done when:** Permissions are enforced on the server, revoked devices are denied and privileged mutations record actor, scope, reason and request ID.

### T10 Build the bilingual UI shell

- [ ] Create public/customer/staff layouts, English/Bengali dictionaries, fonts, navigation, labelled form controls and shared loading/error/status components.

**Depends on:** T04, T06.  
**Output:** `packages/ui`, locale files and route shells from [FRONTEND_PLAN.md](FRONTEND_PLAN.md).  
**Done when:** Both languages render on mobile and desktop, keyboard navigation works and no route shell exposes private data.

### T11 Implement catalogue and coverage models

- [ ] Add productions, performances, capacity revisions, row mapping versions, categories, products, product versions and explicit coverage.

**Depends on:** T07.  
**Output:** Catalogue migrations and services supporting all six product combinations, stage buffers, sale windows and immutable sold snapshots.  
**Done when:** Daily has explicit performance coverage; Season has a frozen list; Back row counts and whole-zone allocation require no code change.

### T12 Build catalogue administration and publication validation

- [ ] Implement show/product/mapping editing and draft, validate, publish, pause and close commands, with role-scoped admin screens.

**Depends on:** T09, T10, T11.  
**Output:** Shows/settings UI and validated admin APIs.  
**Done when:** Unknown capacity, incompatible row overlap, stage overlap and missing prices/terms/contacts prevent publication; sold versions cannot be silently changed. Cover catalogue portions of AC01 and AC02.

### T13 Build public programme and login flows

- [ ] Implement festival/show pages, section/product selection, full Season coverage, mobile/email OTP screens and return-to-booking behavior.

**Depends on:** T08, T10, T12.  
**Output:** Published-only catalogue routes and usable public/customer navigation.  
**Done when:** Users can select a product and verify a contact in either language; hidden products stay unavailable and no seat picker or contact-bearing URL appears.

## Phase 3 Make stock and holds correct

### T14 Add inventory booking and request records

- [ ] Create pools, shared product-cap authority, bookings/items, holds/allocations, adjustments, movement ledger and scoped idempotency records.

**Depends on:** T06, T11.  
**Output:** Migrations, repositories and transaction helpers with the reviewed global lock order.  
**Done when:** Database constraints reject negative/overcommitted counters and duplicate allocations; item snapshots store price, fees, tax, currency and terms.

### T15 Implement atomic Daily and Season holds

- [ ] Implement availability estimates and `POST /v1/holds`, validating identity, sale window, quantity, price version, product cap and every covered pool.

**Depends on:** T08, T14.  
**Output:** Inventory/booking services that lock pools in sorted order and reserve all coverage or none, with ledger entries.  
**Done when:** AC03 and AC04 pass against real PostgreSQL: 100 competing requests cannot reserve more than ten units, and a Season pass obeys its limiting pool.

### T16 Implement hold expiry and safe request replay

- [ ] Add expiry processing with state-checked release, database time and the same booking/hold/pool lock order used for fulfillment.

**Depends on:** T15.  
**Output:** `expire-holds` worker, bounded transaction retries and idempotent hold responses.  
**Done when:** Repeated expiry releases stock once; the same operation key returns its original outcome and changed input returns conflict. Capture races are completed in T23.

### T17 Implement inventory top-up preview and apply

- [ ] Build reserve release and category transfer APIs/UI with source, quantity, reason, impacted performances and expected versions.

**Depends on:** T09, T10, T12, T16.  
**Output:** Inventory dashboard with read-only held/sold/available/admitted counters and audited adjustment history.  
**Done when:** AC01, AC02 and AC06 pass end to end; stale previews, physical ceiling breaches and transfers of held/committed units are rejected.

### T18 Connect booking UI to live holds

- [ ] Add quantity selection, full price breakdown, hold countdown, sold-out/conflict recovery and expired-quote refresh.

**Depends on:** T13, T16.  
**Output:** Booking selection-to-hold flow driven by server state.  
**Done when:** Safe form selections survive stock changes, expired holds cannot reuse old quotes and valid holds preserve price after a catalogue edit. Prove AC13.

## Phase 4 Verify payments and deliver tickets

### T19 Add payment ticket and job schemas

- [ ] Create attempts/payments, webhook events, outbox/jobs, tickets/entitlements/credentials and refund-operation/case records needed for captured-payment exceptions.

**Depends on:** T14.  
**Output:** Migrations with unique provider IDs, item/ordinal, ticket/performance, token hash and active-credential constraints.  
**Done when:** Multiple distinct payments for one booking can be recorded, while duplicate provider payment IDs and duplicate attendee tickets are rejected.

### T20 Implement reliable outbox delivery

- [ ] Write outbox dispatch and consumer deduplication, retry/backoff, dead-letter handling and job status visibility.

**Depends on:** T19.  
**Output:** Worker infrastructure with production SQS adapter and local test transport.  
**Done when:** A crash after commit or duplicate message delivery does not lose an event or repeat its business effect.

### T21 Implement Razorpay order creation and callback verification

- [ ] Verify current provider contracts, configure sandbox credentials and implement the adapter with persisted attempts, stored-order signatures and authoritative payment lookup.

**Depends on:** T16, T19.  
**Output:** Payment-order and verification endpoints with uncertain-attempt recovery.  
**Done when:** Server amounts/currency are authoritative, order timeouts do not immediately create another checkout, and forged/wrong-amount callbacks fail AC08.

### T22 Implement durable webhook ingestion

- [ ] Verify signatures over the raw request body, store valid provider events before acknowledgment and deduplicate/retry processing.

**Depends on:** T20, T21.  
**Output:** Razorpay webhook route and event processing job.  
**Done when:** Invalid signatures cannot mutate payments, valid duplicates are harmless and stored events recover after a worker failure.

### T23 Implement captured-payment fulfillment

- [ ] Create the shared callback/webhook/reconciliation fulfillment transaction: verify capture, convert live holds or reacquire all stock, issue per-person rights and commit outbox events.

**Depends on:** T16, T19, T21, T22.  
**Output:** Idempotent fulfillment service plus late-capture and excess-payment refund cases. No external call occurs inside the stock transaction.  
**Done when:** AC05, AC07 and the backend portion of AC09 pass; expiry races do not double-release, replay cannot duplicate tickets and unavailable late captures issue no ticket.

### T24 Add payment reconciliation and exception visibility

- [ ] Reconcile active uncertain orders every 60 seconds and recent exceptions every five minutes; alert on unresolved captures after five minutes.

**Depends on:** T20, T23.  
**Output:** Reconciliation jobs, assigned exception records and scoped admin summaries.  
**Done when:** Missing webhooks and uncertain calls converge to confirmation or a tracked refund case without reversing terminal states.

### T25 Generate secure tickets and notifications

- [ ] Generate one PDF per attendee using 256-bit opaque credentials, private object storage and asynchronous email/SMS delivery.

**Depends on:** T20, T23.  
**Output:** PDF template, encrypted recoverable digital credentials, owner-only download/resend APIs and delivery retries.  
**Done when:** Re-download reuses the credential, quantity three produces three tickets, receipts cannot grant entry and another customer cannot download a ticket. Prove AC23 and inspect real printed QR readability.

### T26 Complete payment and My tickets screens

- [ ] Integrate hosted Checkout, callback submission, bounded server-status polling, booking details, individual downloads and clear refund/pending states.

**Depends on:** T18, T24, T25.  
**Output:** Complete sandbox purchase and recovery flow in both languages.  
**Done when:** Browser success never independently confirms a booking; closed-browser/failed-email recovery passes AC10, and refund-required status is visible for AC09.

## Phase 5 Implement online admission and the ticket desk

### T27 Add admission and physical-issue persistence

- [ ] Add physical preparations/serials, scan request/results, admissions and incidents with ticket/performance uniqueness and durable request recovery.

**Depends on:** T09, T19.  
**Output:** Migrations and scoped repositories for desk and gate operations.  
**Done when:** PostgreSQL rejects a second standard admission, duplicate serial and conflicting active issue; a replay request is bound to its original input/scope.

### T28 Implement online admission services

- [ ] Validate staff/device/show/gate scope, active credential, ticket/right state, coverage and server time under ticket/entitlement locks.

**Depends on:** T23, T27.  
**Output:** Admission API with explicit result codes, durable receipts, request replay and audited denials.  
**Done when:** AC15, AC16, AC17 and AC22 pass: concurrent gates create one admission, retries return the original receipt and each Season show has independent usage.

### T29 Build the gate scanner and manual fallback

- [ ] Implement camera permission handling, locked shift context, debouncing, large result states, Scan next and UNKNOWN/PAUSED retry using the same UUID.

**Depends on:** T10, T28.  
**Output:** Mobile scanner plus supervised online lookup/admission requiring a reason and the same admission service.  
**Done when:** Offline never turns green; recovered receipts never signal a second entry; camera denial has a usable fallback. Prove AC21 and AC24, and exercise AC26.

### T30 Implement physical exchange and desk printing

- [ ] Build ownership verification, inactive preparation, print/inspect, handover activation, spoiled-stock voiding and preparation-status recovery.

**Depends on:** T25, T27, T28.  
**Output:** Desk APIs/UI that atomically activate physical and revoke digital credentials, plus customer exchange receipts.  
**Done when:** AC18 passes at two concurrent desks; lost activation acknowledgment recovers the existing issue; customer re-download never reveals a physical entry secret.

### T31 Implement replacement and assisted recovery

- [ ] Add supervised purchase-evidence verification, reason capture, atomic credential replacement and incident handling without resetting rights.

**Depends on:** T28, T30.  
**Output:** Recovery service and staff screens with historical usage visible to authorized staff.  
**Done when:** AC19 passes; old credentials are revoked and previously used shows remain denied. No reset-used or offline bypass exists.

## Phase 6 Complete refunds administration and accounting

### T32 Implement cancellation eligibility and rights revocation

- [ ] Complete refund-item/accounting schema and implement stored-policy evaluation for selected tickets or a single Season show, partial usage, disputes and rescheduling.

**Depends on:** T19, T23, T28.  
**Output:** Finance-scoped cancellation transaction with locked amount reservation, eligible future stock release and unique refund operations.  
**Done when:** AC11 and AC20 pass; one cancelled ticket leaves its peers valid, cancelled-show refunds preserve other Season rights and scan/refund races serialize.

### T33 Implement refund provider processing and reconciliation

- [ ] Process refund operations after commit, persist provider IDs and reconcile uncertain replies before retrying; handle late/excess-capture cases from T23.

**Depends on:** T20, T21, T32.  
**Output:** Refund worker, status polling/reconciliation and finance alerts.  
**Done when:** AC14 passes, concurrent requested/succeeded refunds never exceed captured value and failed refunds do not reactivate cancelled rights.

### T34 Finish orders support and finance administration

- [ ] Build owned-contact/reference search, selected-right refund forms, payment/refund history, overview alerts and gate status with role-scoped access.

**Depends on:** T17, T24, T26, T31, T33.  
**Output:** Complete PRD admin navigation and customer refund-status updates.  
**Done when:** Staff can resolve documented exceptions with audit history; customer cancellation remains disabled unless approved policy enables it.

### T35 Implement inventory and financial reconciliation reports

- [ ] Compare pool counters with movements/holds/rights, reconcile provider captures/refunds/settlements and build paginated reports and logged CSV exports.

**Depends on:** T17, T24, T33.  
**Output:** Reconciliation jobs, assigned repair cases, stock/admission/finance reports and CSV formula-injection protection.  
**Done when:** Injected stock mismatch pauses affected sales and opens a case without silently overwriting counters; finance differences retain owners and resolution history.

### T36 Reconcile legacy sales and optional counter channels

- [ ] Add controlled import with dry-run/conflict reporting for any existing paper sales. If enabled, implement explicit-tender counter sales and authorized complimentary issuance through the same stock engine.

**Depends on:** T23, T30, T33, T35.  
**Output:** Import batch/source tracking and opening-ledger report; optional counter screens only if enabled.  
**Done when:** AC28 passes and all accepted legacy passes resolve to central credentials. If no legacy/counter sales exist, record that fact and keep those channels disabled rather than inventing data.

## Phase 7 Prove production readiness and release

### T37 Provision isolated staging and production infrastructure

- [ ] After the hosting/budget decision, create reviewed Terraform for networking, app tasks, private RDS, SQS, private S3/KMS, secrets, logs and restricted deployment credentials.

**Depends on:** T05, T20 and approved D17 for provisioning expenditure. May begin before Phase 6 once these dependencies are met.  
**Output:** Isolated environments, staging deployment pipeline, database backups and deployment/rollback instructions.  
**Done when:** Staging works end to end with test credentials; production keys/data are isolated and private transactional responses bypass CDN caching.

### T38 Implement retention and operational monitoring

- [ ] Add approved retention jobs, legal holds/deletion replay, protected audit exports, PRD alerts and runbooks for outage, capture/refund exceptions, printing, lost passes and compromised devices.

**Depends on:** T31, T33, T35, T37; production retention values require D18 resolution.  
**Output:** Monitoring dashboards/alerts, privacy notices and processor/retention records, on-call ownership and executable runbooks.  
**Done when:** Test alerts reach configured responders, secrets/QRs are absent from logs and deletion/hold behavior is verified on synthetic data.

### T39 Run security accessibility and real-device checks

- [ ] Exercise customer isolation, every privileged route, MFA/revocation, CSRF/CORS/CSP, artwork upload validation, private downloads and secret leakage. Review both languages and printed passes.

**Depends on:** T26, T29, T31, T34, T37.  
**Output:** Security findings with fixes, human Bengali review and mobile/keyboard/screen-reader/printer/camera evidence.  
**Done when:** AC22, AC23 and AC26 pass on staging and no unresolved critical/high security defect remains.

### T40 Run load concurrency and restore drills

- [ ] Run the full PRD acceptance matrix, peak traffic with background jobs, failure injection and restore into a new database, including recent-admission reconciliation and deletion replay.

**Depends on:** T35, T36, T38, T39.  
**Output:** Evidence for AC01 through AC28 and measured results against [roadmap performance/recovery targets](IMPLEMENTATION_PLAN.md).  
**Done when:** No oversell or duplicate admission occurs; load targets pass; AC25 keeps gates paused when admission history is uncertain; AC27 recovery targets pass or launch remains blocked.

### T41 Rehearse the venue and approve launch configuration

- [ ] Obtain final committee/venue/finance sign-offs, import reconciliation, reviewed live configuration and the approved low-value live capture/refund check. Rehearse two gates and the desk with actual phones and printed stock.

**Depends on:** T36, T40 and all applicable launch decisions in [DECISIONS.md](DECISIONS.md).  
**Output:** Signed checklist covering safe capacities, programme, terms, networks, fallback connectivity, power, supplies, trained roster and incident contacts.  
**Done when:** Volunteers demonstrate admit/deny/retry/pause/recovery correctly and finance accounts for the live check and all pre-existing sales.

### T42 Deploy monitor and hand over operations

- [ ] Deploy tested artifacts using compatible migrations, run smoke checks, open sales under the approved configuration and monitor payment, inventory and gate health.

**Depends on:** T41.  
**Output:** Release record, monitored rollout, rollback readiness, support handover and scheduled reconciliation/backup checks.  
**Done when:** The agreed observation window passes, ownership is handed over and no unresolved issue can oversell, admit duplicates, expose tickets or lose financial traceability. Freeze risky changes around performances.

## First implementation session

Complete T01 through T04 first. The concrete outcome is a runnable Next.js/Vinext page, route-handler API connected to local PostgreSQL, a starting worker and reproducible setup instructions. Then add CI and shared contracts in T05/T06 before implementing authentication and inventory. Production credentials and final venue approvals are not needed for that local foundation. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) before claiming task completion.

## Completion record template

Copy this below a task when work starts, or use equivalent fields in your issue tracker:

```text
Task: Txx
Owner:
Status: not started / in progress / blocked / done
Commit or PR:
Verification command or manual scenario:
Result and evidence:
Blocker or follow-up:
```

Check the task box only when its completion criteria pass. Keep implementation status here; keep PRD acceptance evidence and launch sign-offs linked from the roadmap so the two documents remain consistent.
