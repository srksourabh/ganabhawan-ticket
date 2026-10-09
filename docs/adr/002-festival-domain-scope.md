# Festival domain scope: programmes, zones, seasons, refunds and notifications

Status: implemented with the admin configuration work (October 2026). Recorded so later changes do not add schema that the business does not need.

The application sells one festival. Its model is `festival → shows → (per show) capacities per zone → DAILY and SEASON pools`, with products selling from pools through `product_coverage`.

**Programme = performance.** A programme (a drama on a date and time) is a `shows` row. There is no separate programme entity: nothing in the business groups several performances under one programme for sale, pricing or entry. Admins create, edit, publish, unpublish and cancel performances. Add a programme table only if the organiser starts selling one drama across several dates as one item.

**Zones are the venue's three physical zones**: Premier, Superior and Balcony (a database CHECK). Admins configure each zone's capacity, daily and season allocations, online season allocation, prices and on-sale state, but cannot invent zones. Arbitrary zones need a seating-plan requirement first.

**Season coverage changes only by explicit admin action.** A season ticket created from the dashboard covers the published, upcoming performances of its zone. A performance created later does not join it automatically (it would change what season customers bought, and a draft show in the coverage closes season sales). The admin adds a performance with "Add a performance to a season ticket", which is refused once the season ticket has any sale, hold or payment in progress.

**No change-of-mind refunds, no admin refund workflow.** Customers cannot cancel or refund. Refunds happen only through the existing mechanisms: show cancellation (that line's price), a late or excess payment that cannot be fulfilled (all-or-nothing), and the reconciliation/refund state machine. A manual single-booking refund tool needs an explicit business rule first.

**One verified contact is required to buy; notifications go to verified contacts only.** Customer mobile features are behind the server switch `MOBILE_PHONE_NUMBER_ENABLED` (default `false`): while it is off, a verified email is required to buy and every confirmation goes by email; no SMS gateway is called. With it on (and MSG91 fully configured), email-only, mobile-only and email + mobile accounts may buy (changed from "mobile required" by the MSG91/contact requirement of Oct 2026); an account with neither is refused (`CONTACT_REQUIRED`). An email account may add a mobile (SMS code, stored as `users.verified_mobile`). The confirmation goes by SMS (MSG91, the only live SMS provider) to the verified mobile and by email to a verified email. No unverified contact is ever stored or used.

**Carts: guest in the browser, account on the server.** A guest cart merges into the account once at sign-in; the account cart survives sign-out and session expiry and is never stored in the browser. A cart line expires when every performance it covers has ended or been cancelled (a season: its last show). Carts never hold inventory. See docs/HANDOVER.md.

**Holds end only by expiry or payment.** Closing the payment window does not release a hold, because a UPI payment can complete after the browser has gone; the hold expires after the festival's configured hold time.
