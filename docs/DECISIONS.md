# Decision register

## Status and authority

This register records PRD proposals and unresolved launch decisions. Nothing below is recorded as approved merely because it appears in a plan. The committee owns commercial policy, the venue manager capacity and physical flow, finance financial treatment, and engineering integrity and recovery.

For each resolved decision, retain approver, date, evidence, value, effective version and affected product/policy versions. Store signed survey material under `docs/zone-survey/`, approved policy documents under `docs/policies/`, and material architecture changes under `docs/adr/` when available.

## PRD defaults requiring confirmation

| ID | Proposed default | Required decision/evidence | Owner |
| --- | --- | --- | --- |
| D01 | Organisation **Samatat Sanskriti**; venue **Ganabhawan** (configurable) | Official venue spelling/address if changed; organisation branding confirmed | Committee/venue |
| D02 | Daily is one performance | Confirm public wording; whole-day access requires explicit DAY_PASS coverage | Committee |
| D03 | Season has a frozen included-show list | Programme, sale cutoff and handling of later additions; default new future-only version for later sales | Committee |
| D04 | Season rows Front 4, Back 2, Balcony 2 | Signed row survey; Back 4-row alternative remains configurable | Venue |
| D05 | Row labels internal; no assigned seats | Signage and enforceable category boundaries | Venue/operations |
| D06 | One ticket per person per covered performance | Quantity/child/companion policies | Committee |
| D07 | No standard external re-entry | Controlled intermission, late entry and incident procedure | Committee/operations |
| D08 | Digital admission until optional physical exchange | Optional versus mandatory exchange, disclosure and desk throughput | Committee/operations |
| D09 | INR, integer paise, UTC storage, Asia/Kolkata display | Finance and operational confirmation | Finance |

## Additional launch decisions

| ID | Open item and provisional direction | Owner | Blocks |
| --- | --- | --- | --- |
| D10 | Survey capacities, safety blocks, accessible/companion allocations, Front subzone interpretation and approved reserve | Venue manager with owner approval for ceilings | Real inventory/publication |
| D11 | Ten-minute hold and maximum six tickets/order; confirm product caps and abuse limits | Committee/engineering | Checkout configuration |
| D12 | Entry opens 60 minutes before curtain and closes 15 minutes after; confirm production-specific rules | Operations/productions | Gate configuration |
| D13 | Six category prices, fees/tax treatment and applicable receipt details; no assumed statutory rates | Finance | Paid sale |
| D14 | Refund cutoffs, fees, processing wording, Season show weights, rescheduling and partial usage | Committee/finance | Terms/publication; self-service cancellation remains disabled |
| D15 | Transfer/name checks, child booking, accessibility assistance and evidence for account/pass recovery | Committee/support | Public terms and recovery training |
| D16 | Razorpay onboarding/capture settings, webhook secrets, SMS/email providers and delivery budget | Finance/engineering | End-to-end paid checkout |
| D17 | Hosted Postgres (Neon free/paid) + Cloudflare Workers/Hyperdrive; budget and backup/retention confirmed | Committee/engineering | Production provisioning |
| D18 | Privacy/grievance owner, notices, processors, retention periods and launch-date legal applicability | Committee/legal/finance | Public launch |
| D19 | Staff roster, roles, MFA, device assignment, refund approval threshold and incident escalation | Owner/operations | Staff access/rehearsal |
| D20 | Paper sales import, counter tender, complimentary authorization, opening ledger and legacy credential migration | Ticket desk/finance | Public stock release |
| D21 | Venue networks, mobile fallback, charged spares, printer stock, signage and support shifts | Operations | Admission launch |
| D22 | Bengali/English reviewed copy, fonts, real-device performance profile and final artwork | Design/committee | Experience acceptance |

## Architecture baseline and future review

Carry forward a modular TypeScript monolith, Next.js route handlers, transactional PostgreSQL, Drizzle/node-postgres plus locking SQL, and a separately runnable worker. The current deployment target is Vinext on Cloudflare Workers with Chroma for non-authoritative catalogue retrieval. AWS deployment, SQS outbox and private ticket storage remain optional proposals, not assumptions in application logic.

Write architecture decision records when the implementation fixes the lock protocol/isolation level, encrypted credential lifecycle, payment/refund uncertainty handling and tested recovery topology. A budget-driven hosting change must preserve transaction, durability, restore and online-gate guarantees.

## Scope boundaries

MVP includes bilingual booking/recovery, six configurable categories, safe Season stock, verified payments, PDFs, physical issue/replacement, online gates, refunds, staff MFA/RBAC, audit and tested recovery. Counter/complimentary sales are optional features but must use the central engine if enabled. Existing paper sales must be reconciled before launch.

Phase 2 includes visual row editing, multi-venue planning, waitlists, controlled no-show release, promotions, wallet passes, additional messaging channels, specialized print hardware, advanced analytics and any single-authority local gate-server design. Assigned seats, resale marketplace, independent offline gates and native mobile apps are outside MVP.

Schema and contract work can proceed using explicit configurable defaults. Public sales require the relevant configuration and policy decisions to be approved and versioned; illustrative capacities or unapproved terms cannot pass publication validation.
