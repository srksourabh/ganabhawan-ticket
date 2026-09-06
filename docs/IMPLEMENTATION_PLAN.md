# Implementation roadmap and acceptance plan

For the actionable build sequence, use [the step by step task list](TASKS.md). This roadmap defines milestones, acceptance coverage and launch gates; [implementation status](IMPLEMENTATION_STATUS.md) records verified progress.

## Delivery approach

Build the PRD's integrity guarantees before production checkout and gate use. The indicative schedule is six to eight weeks after venue data and policy decisions, assuming two full-stack engineers and part-time design, QA and operations. It is a planning estimate, not a delivery commitment or a record of assigned staff.

Track implementation against the [frontend](FRONTEND_PLAN.md), [backend](BACKEND_PLAN.md), [database](DATABASE_PLAN.md) and [decision register](DECISIONS.md). Unchecked work below is planned, not completed; current verified work is listed in [implementation status](IMPLEMENTATION_STATUS.md).

## Milestones and dependencies

| Milestone | Indicative timing | Deliverables | Exit evidence |
| --- | --- | --- | --- |
| M0 Decisions and contracts | Week 1 | Venue survey, policy register, entity/schema review, API types, UI flow and threat review | Owners resolve launch configuration or explicitly track blockers; shared stock/admission invariants reviewed |
| M1 Foundation and stock | Weeks 2–3 | Workspace/CI, environments, OTP/staff auth, catalogue, mappings, pools, holds, expiry and top-up | Invalid publication blocked; real PostgreSQL race tests show no oversell |
| M2 Paid booking and tickets | Week 4 | Razorpay adapter, durable webhooks, fulfillment, reconciliation, PDFs, My tickets and delivery | Capture/expiry/replay cases pass; one ticket per attendee and browser/email recovery work |
| M3 Desk and admission | Week 5 | Two-stage exchange, replacement, scanner, scope/device controls and incidents | Two-gate and two-desk races pass; retry receipts and offline pause behavior verified |
| M4 Refunds and resilience | Week 6 | Selected-right cancellation, refund reconciliation, reporting, ledger repair cases, retention and runbooks | Scan/refund races, amount limits, import reconciliation and restore procedure pass |
| M5 Rehearsal and release | Weeks 7–8 | Bilingual accessibility review, load/security checks, real print/gate rehearsal and launch configuration | All launch gates signed; unresolved integrity defects block release |

Dependencies: approved capacity/mappings enable real pools; immutable coverage and item snapshots enable safe fulfillment; fulfillment enables PDFs/exchange; stable entitlements and credential rules enable admission; refunds depend on admission history and stored commercial policy. Frontend contract fixtures and UI design can progress while those backend foundations are built.

## Work checklist

- [ ] M0: Resolve venue identity, capacity, programme, Daily/Season scope, exchange and refund terms; record owners and policy versions.
- [ ] M0: Define OpenAPI/schema contracts, transaction lock protocol and scoped roles; review all three implementation plans together.
- [ ] M1: Scaffold the planned workspace and pin supported dependencies; create synthetic fixtures and isolated staging.
- [ ] M1: Configure CI, secret scanning, migration review, short-lived deployment credentials and smoke checks.
- [ ] M1: Implement identity/catalogue/publication and stock transactions with their database constraints.
- [ ] M2: Implement uncertain payment recovery, raw webhook verification and shared idempotent fulfillment.
- [ ] M2: Implement owned booking recovery, secure PDFs and asynchronous notification retry.
- [ ] M3: Implement physical preparation/activation/replacement and online scanner request recovery.
- [ ] M4: Implement selected-ticket/show refunds, amount reservation, reports, imports and discrepancy ownership.
- [ ] M4: Write runbooks for outage, uncertain capture, refund failure, lost pass, printer failure, restore and compromised devices.
- [ ] M5: Complete the acceptance matrix, operational drills and approved live capture/refund check.
- [ ] M5: Obtain sign-offs, deploy tested artifacts, observe rollout and record rollback readiness.

## PRD acceptance traceability

Use real PostgreSQL connections for concurrency tests. Fixtures and screenshots alone cannot prove stock, payment or admission integrity. Each acceptance record should identify the build, environment, test data, expected/actual outcome and evidence location.

| PRD ID | Required evidence | Main layers | Milestone |
| --- | --- | --- | --- |
| AC01 | Back Season changes from two to four rows without code; overlap/capacity rejected | Admin/API/DB | M1 |
| AC02 | Whole Front Season and Back Daily; unused products disabled publicly | Catalogue/UI/DB | M1 |
| AC03 | 100 concurrent requests for ten units yield at most ten held/confirmed | Inventory/DB | M1 |
| AC04 | Season limited by a two-unit covered pool; every covered reservation commits or none | Inventory/DB | M1 |
| AC05 | Expiry and capture race causes one release/conversion and correct late path | Payments/inventory/DB | M2 |
| AC06 | Over-ceiling and stale-preview top-ups rejected with clear audited conflicts | Admin/inventory/DB | M1 |
| AC07 | Duplicate/out-of-order events issue tickets and move stock once | Payments/workers/DB | M2 |
| AC08 | Forged callback or amount mismatch never confirms and records security outcome | Payments | M2 |
| AC09 | Late capture without stock yields no ticket and a visible tracked refund | Payments/refunds/UI | M2 |
| AC10 | Closed browser plus failed email still recovers booking by OTP safely | Identity/tickets/UI/jobs | M2 |
| AC11 | Cancel one of three tickets; only its eligible rights revoked | Refunds/DB/UI | M4 |
| AC12 | OTP replay, expiry and exhaustion rejected with neutral rate-limited responses | Identity/UI | M1 |
| AC13 | Price edit preserves valid hold quote and updates new quotes | Catalogue/booking/UI | M2 |
| AC14 | Lost refund response recovers existing operation without duplicate amount | Refunds/provider/DB | M4 |
| AC15 | Same QR at two gates creates exactly one admission | Admissions/DB | M3 |
| AC16 | Lost committed scan response recovers same UUID receipt without a second entry signal | Admissions/scanner | M3 |
| AC17 | Season A then B admitted once each; repeat A and uncovered C denied | Admissions/coverage | M3 |
| AC18 | Two desks racing exchange activate one physical issue and revoke digital | Physical issue/DB/UI | M3 |
| AC19 | Replacement of used pass revokes old token without restoring used rights | Credentials/admissions | M3 |
| AC20 | Refund and scan serialize; cancellation committed first prevents entry | Refunds/admissions/DB | M4 |
| AC21 | All connectivity lost produces no green result and follows pause procedure | Scanner/operations | M3/M5 |
| AC22 | Scanner cannot access another show or admin mutations | Identity/API | M3 |
| AC23 | Customer cannot retrieve another customer's ticket or private details | API/download/storage | M2 |
| AC24 | Supervisor lookup/admission records reason/actor and obeys uniqueness | Admissions/audit/UI | M3 |
| AC25 | Restore missing recent admissions remains paused until reconciled | Database/operations | M5 |
| AC26 | Bengali mobile flow readable/accessible; camera fallback has no dead end | Frontend/operations | M5 |
| AC27 | Load and recovery targets pass or launch is deferred | All/operations | M5 |
| AC28 | Paper import, sales, refunds and top-ups reconcile with central ledger | Inventory/finance/desk | M4/M5 |

Add integration cases for concurrent refund amount limits, excess captures, idempotency-key input mismatch, product caps across versions, credential activation response loss and restored deletion replay. These supplement the PRD scenarios where the proposed schema adds explicit supporting records.

## Performance and reliability gates

Validate against the PRD baseline: 1,000 concurrent browsers, 50 hold requests/second for a five-minute burst and 20 devices totaling 20 scans/second. Revise only through recorded demand planning.

- Admission server p95 below 500 ms; healthy-network end-to-end below 1.5 seconds.
- Catalogue response p95 below one second; mobile LCP below 2.5 seconds on an agreed profile.
- At least 95% of healthy-provider captures expose tickets within 60 seconds.
- Target 99.9% availability during sales/festival windows, with provider outages measured separately.
- Prove stock and admission invariants under peak load, worker retries and injected failures.
- Drill AZ failure RTO 15 minutes, logical DB RPO five minutes/RTO two hours, and regional RPO 24 hours/RTO eight hours.

These are acceptance targets from the PRD, not claims about an existing deployment. Gate traffic takes priority over exports and bulk reporting. Do not reopen after restoration until recent admissions can be trusted.

## Release approval and operations

| Owner | Required sign-off |
| --- | --- |
| Committee | Programme, scope, prices, public terms, exchange policy, support and reviewed bilingual copy |
| Venue manager | Signed safe capacities, row mappings, accessibility allocations, signage and physical flow |
| Finance | Razorpay onboarding, fee/tax/refund treatment, paper-sales reconciliation and approved low-value live capture/refund check |
| Engineering/security | Integrity tests, isolation/permissions, monitored deployment, backup restore and no unresolved critical/high security issues |
| Operations | Two-gate rehearsal with actual phones/printed stock, fallback networks, power, supplies, roster and pause procedure |

Freeze risky changes around each performance. Use backward-compatible migrations, staging validation and monitored rollout/rollback. No launch defect may permit overselling, duplicate admission, private-ticket exposure or broken financial traceability.

Prepare a current hosting and operating estimate before infrastructure purchase, including application tasks, database standby, load balancer, networking, WAF, storage, backups, logs, payment fees, OTP delivery, domain, printing and support. Do not interpret the PRD stack as an approved spending commitment.
