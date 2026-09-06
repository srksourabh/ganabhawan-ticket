# Backend implementation plan

## Architecture and boundaries

Implement the PRD's TypeScript modular monolith through Next.js route handlers and separately runnable Node workers, with PostgreSQL as the transactional authority. The current deployment target is Vinext on Cloudflare Workers; hosted PostgreSQL, Chroma, object storage and delivery providers remain external configuration. The AWS/SQS/S3 topology is an optional PRD deployment baseline and must not be assumed by application logic.

Keep stock, fulfillment, credential changes, cancellations and admissions inside explicit database transactions. No provider, queue, email, SMS, PDF or storage call runs while inventory or admission locks are held. Use node-postgres/Drizzle for ordinary access and reviewed SQL for critical locking and constraints.

## Modules and responsibilities

| Module | Responsibility |
| --- | --- |
| Identity | Customer OTP, verified contacts, sessions, staff MFA, roles, show/gate scope and device revocation |
| Catalogue | Festival, production, performance, category, mapping, policy and immutable product versions |
| Inventory | Capacity validation, holds, expiry, pool allocation, reserve transfers and movement ledger |
| Bookings | Owned orders, item snapshots, status transitions and support recovery |
| Payments | Razorpay adapter, attempts, signatures, webhook ingestion and capture reconciliation |
| Fulfillment | One idempotent transaction for verified captures and ticket issuance |
| Tickets | Per-person tickets, entitlements, credentials, secure PDF access and resend |
| Physical issues | Prepare, print recovery, activate, void and supervised replacement |
| Admissions | Online validation, receipt recovery, uniqueness and scoped manual admission |
| Refunds | Eligibility, selected-right cancellation, refund operations and uncertainty reconciliation |
| Notifications | Transactional delivery, retry and separate optional marketing consent |
| Audit/reporting | Privileged changes, every gate decision, financial reconciliation and sanitized exports |

Use controller, service, repository and schemas within each module. Centralize authentication, authorization, input validation, error mapping, idempotency and secret-safe logging in `common/`.

## API contract plan

Write `packages/contracts/openapi.yaml` before integrating screens. All responses include `request_id`. Require scoped `Idempotency-Key` for money and stock mutations; persist input digest and original outcome, and return conflict for key reuse with different input. Admission additionally uses its durable request UUID.

| Method and path | Main rule |
| --- | --- |
| `GET /v1/festivals`, `GET /v1/performances` | Published catalogue only |
| `GET /v1/products/{id}/availability` | Estimate only; include product version |
| `POST /v1/auth/otp/request`, `/v1/auth/otp/verify` | Purpose-bound, rate-limited contact proof |
| `POST /v1/holds` | Verified customer, product version and positive quantity; reserve all coverage |
| `POST /v1/bookings/{id}/payment-order` | Owner only; persisted attempt and uncertain-order recovery |
| `POST /v1/payments/verify` | Verify stored-order signature and authoritative provider state |
| `POST /v1/webhooks/razorpay` | Exact raw-body signature, durable receipt before acknowledgment |
| `GET /v1/me/bookings` | Owned booking/payment/refund summaries |
| `GET /v1/tickets/{id}/download` | Owner check, active digital credential, private access |
| `POST /v1/physical-issues/prepare`, `POST /v1/physical-issues/{id}/activate` | Authorized desk and recorded proof; two-stage exchange |
| `POST /v1/admissions` | Scoped staff, token, performance, device and request UUID |
| `POST /v1/admin/inventory/adjustments` | Source, delta, reason and expected versions |
| `POST /v1/admin/tickets/{id}/replacement` | Supervisor, ownership evidence and reason |
| `POST /v1/admin/refunds` | Finance, selected tickets/entitlements, amount and reason |
| `GET /v1/admin/audit`, `GET /v1/admin/reports` | Role scope, pagination and logged exports |

Add explicit contracts for booking detail/polling, resend, physical preparation status/void, inventory adjustment preview, staff lookup/manual admission, devices and assignments. Catalogue administration needs validated create/update plus publish/pause commands. These supporting endpoints are design additions; unrestricted state-edit endpoints are prohibited.

Errors: `400` input, `401` unauthenticated, `403` denied, `404` inaccessible object, `409` state/stock/version conflict, `429` limited, `503` retryable failure. Gate business denials may be successful HTTP responses with the PRD's explicit result codes. Never expose stack traces or private object existence.

## Identity and authorization

Implement CUS01–04 and SEC01 with normalized mobile/email, at least one verified channel before checkout, unique verified contact ownership and no merge based on unverified matches. Proposed OTP defaults: six digits, five-minute expiry, five attempts, 30-second cooldown and five sends per destination/hour plus IP/device controls. Store keyed hashes; invalidate on use and never log codes.

Use HttpOnly secure sessions, expiry and CSRF protection. Contact linking proves account ownership and the new channel. Assisted recovery requires supervisor evidence and audit. Minimize historical data exposure for recycled phone numbers.

Owner manages roles and approved ceilings; inventory manager adjusts allocations; finance approves refunds; desk issues passes; scanners access assigned gates/shows; supervisors handle incidents. Every protected service checks permission and scope independently of UI visibility. Require individual staff MFA and stronger supervisor verification for sensitive recovery.

## Commerce transaction design

### Reserve and expire

- Validate published product version, sale window, quantity, contact proof and policy snapshots.
- Lock applicable booking/hold records and covered pools in the order defined in the database plan. Enforce both pool stock and any product cap.
- Reserve quantity in every covered performance or none. Persist hold allocations, quote and expiry using database/server time.
- Expiry uses the same lock order as fulfillment, checks current state and releases held units once. Record every movement.
- Top-up preview is advisory. Apply locks all affected capacity/pool records, revalidates expected versions and transfers only unheld/uncommitted units or approved reserve.

### Payment and fulfillment

1. Persist a payment attempt before calling Razorpay. Create the provider order from stored paise, currency and booking reference; retain uncertain state if the call times out.
2. Verify callback signature using the stored order ID. Fetch/verify capture status as required by the current provider contract. Authorized is pending.
3. Verify webhooks over the exact raw body, durably persist authenticated events and deduplicate provider event IDs before returning success. Invalid signatures never enter fulfillment.
4. Callback, webhook and reconciliation invoke the same fulfillment service. Require matching order, unique payment ID, captured status, amount and currency.
5. Under booking/hold/pool locks, either convert a live hold from held to committed or reacquire every expired pool. Never decrement stock twice.
6. If reacquisition fails, record capture and `REFUND_REQUIRED` with no ticket. If it succeeds, create one ticket per item ordinal, frozen coverage entitlements, credentials and outbox records and mark `CONFIRMED` atomically.
7. If an already-fulfilled booking receives another captured payment, preserve its tickets and create an excess-payment refund case. Replay of the same payment returns the existing result.
8. Generate PDFs and send messages after commit. Delivery failures retry independently of booking confirmation.

Booking states start with `DRAFT -> HELD -> PAYMENT_PENDING -> CONFIRMED`; unpaid expired holds become `EXPIRED`, and unsuccessful late capture becomes `REFUND_REQUIRED`. Payment states `CREATED`, `AUTHORIZED`, `CAPTURED`, `FAILED` and refund states `REQUESTED`, `PROCESSING`, `SUCCEEDED`, `FAILED` are separate. Model partial cancellations from ticket/entitlement/refund records; do not mark an entire multi-ticket booking cancelled when one right is revoked.

### Refunds and cancellation

Public self-service cancellation stays disabled until policy approval. Evaluate stored policy, cutoff, usage and selected rights. Lock payment/refund accounting and affected tickets/entitlements in the shared order. Block eligible future entry, release eligible future commitments once and create a unique refund operation in the same transaction.

Call Razorpay after commit. Persist provider refund identity and reconcile uncertain replies before another attempt; do not assume provider idempotency. Serialize refund amount reservations so concurrent operations cannot exceed captured value. A failed refund leaves rights cancelled and alerts finance.

Single-show Season refunds revoke only the affected entitlement and use purchase-time price weights or another frozen approved formula. Preserve other shows and used admissions. Full-pass and partial-order cancellation name affected rights explicitly. Disputes suspend unused rights pending review. Rescheduling retains performance identity and triggers the approved notification/refund workflow.

## Credentials and admission

Generate 256-bit random opaque tokens with a format version; use a lookup hash and encrypted recoverable material where needed. PDFs reuse the active digital credential. Tokens, OTPs and contacts must not enter logs or analytics.

Physical preparation creates an inactive token and unique serial. Activation locks the ticket, verifies preparation and evidence, revokes the old credential and activates the new one atomically. Recovery returns the existing issue after lost acknowledgment. Replacement follows the same transaction and retains all entitlements and usage.

Admission authenticates staff/device/show/gate, then locks the ticket and entitlement. Recheck active credential, ticket/entitlement status, coverage and server entry window. Insert the unique admission and durable receipt before returning `ADMITTED`. Same UUID and same input return the original result explicitly marked as replay; new scans of used rights return `ALREADY_USED`.

Persist denial/retry outcomes for traceability and request recovery without exposing invalid-token personal information. Cancellation and credential changes share the same ticket lock protocol. Manual supervisor admission uses the same uniqueness constraint and requires a reason. No offline admission or reset-used API exists in MVP.

## Workers and operational services

| Job | Trigger/target | Recovery behavior |
| --- | --- | --- |
| Hold expiry | At expiry; proposed frequent sweep with measured lag | State-checked release once |
| Active payment reconciliation | Every 60 seconds | Recover uncertain creation/capture through shared fulfillment |
| Recent payment exceptions | Every five minutes | Assigned case until resolved |
| Outbox dispatch | Continuous | At-least-once publish with consumer deduplication |
| PDF and notification delivery | Fulfillment outbox | Bounded retry, existing credential, dead-letter alert |
| Refund processing | Refund outbox and scheduled reconciliation | Reconcile uncertain provider result before retry |
| Inventory reconciliation | Scheduled; cadence set before launch | Compare ledger/allocations/counters, pause affected sales on mismatch |
| Finance reconciliation | Daily | Captures, fees, refunds and settlement references; owner per discrepancy |
| Audit export and retention | Scheduled | Protected exports, legal holds and deletion ledger |

Monitor the PRD's scan errors above 1% for two minutes, scan p95 above one second for five minutes, webhook lag above two minutes, captures unresolved after five minutes, any stock violation, dead letters, refund failures, DB saturation and backup failure. Prioritize admission over exports and use bounded queues, connection limits and load shedding.

## Implementation and evidence

Build contracts/identity/catalogue, then inventory and concurrency tests, then payments/fulfillment, tickets/desk/admissions, refunds/reporting and operational recovery. Use real PostgreSQL for locking tests and a provider sandbox for signature, replay and late-capture cases. Document current provider behavior before adapter implementation, and complete the approved low-value live capture/refund rehearsal before launch.

The full acceptance mapping is in [Implementation plan](IMPLEMENTATION_PLAN.md). Targets include zero oversells, zero duplicate standard admissions, at least 95% of healthy-provider captures exposing tickets within 60 seconds and traceable privileged/gate actions.
