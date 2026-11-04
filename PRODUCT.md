# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Festival-goers in and around Uttarpara buying seats for Samatat Natyomela at Ganabhawan. Staff also use the same app for admin and gate scanning (out of scope for this visual pass).

## Product Purpose

Sell and hold festival tickets (daily seats and all-together passes), take payment, deliver confirmation, and let customers prove their booking at the door.

## Positioning

Official Samatat Sanskriti ticket desk for Natyomela at Ganabhawan — not a generic ticketing SaaS. Programme, zones, and handover language belong to this company and this hall.

## Operating Context

Bengali-first public UI with English toggle. Email OTP / Clerk sign-in. Cart holds for about ten minutes at payment. Physical ticket handover at the venue.

## Capabilities and Constraints

- Public ticket catalogue, zone selection with hall plan, cart, Razorpay checkout, confirmation.
- Shared CSS tokens power public and admin; this rebrand pass intentionally restyles **public** surfaces only (home, header, catalogue/book, cart/checkout, login, favicon/PWA chrome). Do not rewrite admin layouts, ticket emails, or Razorpay theme in this pass.
- Festival product dates remain 2026 as in `src/lib/brand.ts`. The master poster may show an older year as artwork; treat it as visual reference unless product copy is updated separately.

## Brand Commitments

- Organisation: Samatat Sanskriti / সমতট সংস্কৃতি.
- Festival: Samatat Natyomela / সমতট নাট্যমেলা.
- Master festival poster (yellow field, black woodcut title, red accents, B&W emblem) is the visual north star for the public site: poster-inspired, not a literal full-yellow wall of yellow on every form.
- Emblem (masks + spotlight square) is the favicon and share identity mark; full poster is the link-preview / hero art when appropriate.
- Binding choices from the owner: (1) poster-inspired warm yellow wash + black type energy + red accents with cream/white cards for booking tasks; (2) public surfaces only this pass.

## Evidence on Hand

- Master poster: `public/images/samatat/master-poster.png` (and user upload of the same art).
- Wordmark / emblem: `public/images/samatat/logo.png`.
- Programme stills under `public/images/samatat/shows/`.
- Do not invent testimonials, counts, or dates beyond brand.ts and seeded programme data.

## Product Principles

1. The festival's graphic voice leads public pages; booking clarity wins on operate screens.
2. Bengali typography must stay legible (diacritics, line-height).
3. Real hall and programme assets beat decorative placeholders.
4. Holds, prices, and zone names stay factual and localised.
5. Admin/ops tools stay usable even when public chrome changes.

## Accessibility & Inclusion

Body text contrast ≥4.5:1 on yellow wash and on white cards. Primary actions meet contrast on red. Keyboard focus visible. Locale toggle remains available.
