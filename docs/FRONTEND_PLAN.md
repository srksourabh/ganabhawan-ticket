# Frontend implementation plan

## Scope and foundation

Build one responsive Next.js application with React and TypeScript for public customers and authenticated staff. The current runtime is Vinext on Cloudflare Workers. Follow the PRD's visual direction: warm paper, deep maroon and restrained brass, with readable Bengali and English copy. Treat the auditorium sketch as guidance; display only approved zone information, never a seat picker or an asserted unsurveyed capacity.

This plan implements CUS01–04, ADM01–02, TKT01, PHY01–03 and GATE01–04. Backend authorization remains mandatory even when the interface hides unavailable actions. The stack is inherited from the PRD; package versions will be pinned when implementation begins.

## Routes and screens

Route paths below are proposed UI contracts. Public language routes use `/[lang]` with `en` and `bn`; staff routes must also support reviewed operational translations.

| Route | Audience | Behavior |
| --- | --- | --- |
| `/[lang]/festival/[slug]` | Public | Programme, venue, contact, terms, accessibility help, show details and booking links |
| `/[lang]/book/[productId]` | Customer | Category and quantity selection, exact Daily show or full Season coverage, quote, verification, hold and payment |
| `/[lang]/login` | Customer | Mobile OR email OTP, neutral errors, resend countdown and return to intended route |
| `/[lang]/my-tickets` | Customer | Owned bookings, pending/refund status and recoverable tickets |
| `/[lang]/my-tickets/[bookingId]` | Customer | Individual attendee tickets, secure downloads, resend and exchange receipts |
| `/[lang]/admin` | Staff by role | Overview, pending captures, refund exceptions, low stock and gate connectivity |
| `/[lang]/admin/shows` | Catalogue permission | Festival, productions, performances, buffers, entry windows and publication validation |
| `/[lang]/admin/inventory` | Inventory manager | Zone mappings, pool counters, approved ceiling, reserve/transfer preview and apply |
| `/[lang]/admin/orders` | Authorized support/finance | Reference or verified-contact search, payment history and selected-ticket cancellation |
| `/[lang]/admin/ticket-desk` | Desk staff | Exchange preparation, printing, handover activation and issue recovery |
| `/[lang]/admin/gate-status` | Supervisor | Gate assignment, connectivity and incidents |
| `/[lang]/admin/reports` | Scoped reporting role | Stock, admissions, captures, refunds and export status |
| `/[lang]/gate` | Assigned scanner | Shift context, scan, server result, same-request recovery and controlled lookup |

Role administration, venue revisions, policies and staff assignments belong in owner-only settings. The main admin navigation stays aligned with the PRD: Overview, Shows, Inventory, Orders, Ticket desk, Gate status and Reports.

## Booking and customer flows

1. Load published product versions and coverage. Show production, troupe, exact IST time, venue, category and entry policy. Disabled allocations cannot be purchased.
2. Select quantity, provisionally capped at six by approved configuration. Show subtotal, fees, tax and total; never assume a tax rate. Identify tickets as one per person.
3. Verify at least one contact using OTP. Preserve selection during verification without persisting OTPs or sensitive contacts in URLs or analytics.
4. Request an authoritative hold from the backend. Display its server expiry and stored quote. Availability displayed before this step is an estimate.
5. Open Razorpay hosted Checkout using the server-created payment order. Prevent accidental repeated submission; retries reuse the same operation key where appropriate.
6. Submit callback details for server verification, then poll owned booking status with bounded backoff. Browser success alone must display verification pending, never a confirmed ticket.
7. On expiry, explain that the quote must be refreshed. On late capture without stock, display the tracked refund case. On uncertain order creation, recover that attempt before offering another payment.
8. Confirmed bookings remain accessible through My tickets even if the browser closed or notification failed. Downloading or resending uses the existing active digital credential.

Provide explicit states for loading, sold out, stock changed, expired hold, payment pending, confirmed, refund required, refund processing, refund failed and cancelled. Retain safe form selections when retrying and show a request reference for support. A transport error must not imply payment failure.

After physical exchange, replace the customer download action with an exchange receipt and recovery instructions. Never expose the active physical QR through customer re-download. Keep public cancellation disabled until approved terms enable it; when enabled, use server-reported eligibility for individual tickets.

## Inventory and catalogue administration

- Separate production metadata from scheduled performances. Show overlap errors including setup and clearing buffers.
- Configure all six category/type combinations, row ranges and sale windows. Support Back Season two or four rows and whole-zone allocation without code changes.
- Show allocated, held, sold/committed, cancelled, available and admitted as distinct values. Held, sold, available and admitted are read-only.
- For top-up, collect reserve/transfer source, quantity and reason. Preview all affected performances and the limiting Season pool. Apply using expected versions; a conflict requires a new preview.
- Show mapping and price versions and impacted existing sales. Do not silently migrate sold rights to a changed configuration.
- Publication displays unmet capacity, coverage, price, terms and support requirements. Sales pause is separate from admission status.
- Refund forms select ticket IDs or a specific Season entitlement, show approved amount and reason, and preserve other tickets. Failed refunds remain visible finance exceptions.

## Ticket desk workflow

1. Scan digital proof, retrieve the ticket through an authorized API and complete OTP or approved evidence verification.
2. Prepare an inactive physical credential and unique serial. Show the preparation reference and a print preview.
3. Print and inspect stock. Reprinting before handover reuses the preparation; spoiled stock is voided and handled according to the desk runbook.
4. At handover, activate the prepared issue. Show success only after the server confirms that physical activation and digital revocation committed together.
5. If the response is lost, recover the same preparation's status. Never start a second issue merely because the first request timed out.
6. Lost-pass replacement requires supervisor verification and a reason. Display existing used performances so staff can see that replacement does not reset access.

PDF tickets use one QR per person, masked contact, reference, category, exact Daily performance or Season coverage, terms and support. No seat numbers. Validate QR quiet zone and contrast, starting at 30 mm on paper, using actual printers and cameras. Order and exchange receipts are clearly marked as non-entry documents.

## Gate scanner state machine

```text
SHIFT CHECK -> READY -> SUBMITTING -> RESULT -> SCAN NEXT -> READY
                         |
                         +-> UNKNOWN/PAUSED -> RETRY SAME UUID -> RESULT
```

Staff confirm assigned show and gate before scanning; only a supervisor can change locked shift context. Send token, performance ID, device ID and a fresh request UUID for each intentional scan. Debounce camera frames while a request/result is active.

| Server result | Interface behavior |
| --- | --- |
| `ADMITTED` for a new admission | Clear entry authorization with section, receipt and server time |
| Replayed receipt for the same UUID | Explicit recovered/retry receipt; do not signal a second admission |
| `ALREADY_USED` | Deny with original time/gate and supervisor escalation |
| `WRONG_SHOW`, `OUTSIDE_WINDOW`, `PHYSICAL_REQUIRED` | Deny with an actionable operational explanation |
| `INVALID`, `REVOKED`, `CANCELLED`, `NO_PERMISSION` | Deny; invalid tokens expose no customer data |
| `RETRY_REQUIRED`, timeout or offline | UNKNOWN/PAUSED; never green; recover the same request |

Keep the result visible until Scan next. Use text and icons in addition to color; optional sound/vibration must not be the sole signal. Camera denial offers staff-controlled reference lookup using the same online checks. Supervisor incident handling records a reason and never provides a reset-used action. Do not cache valid admission decisions for offline use.

## Components, contracts and security

- Shared components: language switcher, programme card, category selector, coverage list, quantity field, price breakdown, OTP form, hold countdown, booking status, ticket card, inventory table, adjustment preview, print panel and scan result.
- Keep authoritative price, stock, payment, ticket and scan state on the server. Use local state for selection, camera control and presentation only.
- Consume versioned types from `packages/contracts`; standardize handling of `409`, `429`, `503` and response `request_id`.
- Use secure HttpOnly sessions and CSRF integration. Never store credentials in local storage. Gate token submission must bypass analytics and error payload capture.
- Public programme/assets may be cached. Authenticated ticket, payment and admission responses must use `no-store`; prevent service-worker or CDN caching of these responses.
- Provide labelled fields, visible focus, keyboard access, screen-reader status announcements, at least 44 px scanner targets, mobile text wrapping and unobscured pay actions.
- Package and test Bengali fonts and obtain human translation review. Display Asia/Kolkata time explicitly and INR totals derived from integer paise.

## Build order and validation

1. Define route shells, bilingual copy keys, UI tokens and generated API types.
2. Implement catalogue, OTP and booking state screens against contract fixtures; fixtures never establish production availability.
3. Integrate real holds, payment verification, recovery and My tickets.
4. Implement inventory, order support, refunds and role-specific administration.
5. Implement desk printing/activation and scanner recovery with real backend transactions.
6. Run Playwright customer/staff flows, keyboard/screen-reader checks, Bengali mobile review and physical printer/camera rehearsal.

Frontend evidence must cover AC01–02, AC06, AC09–10, AC13, AC16, AC18–19, AC21–24 and AC26, with backend integration for state correctness. Measure mobile LCP below 2.5 seconds on the agreed test profile and healthy-network scan completion below 1.5 seconds. These are PRD targets, not existing measurements.
