-- 0010: the admin's switch for NEW season-ticket sales, separate from the
-- operator's global ALLOW_PUBLIC_SALES and from each product's "On sale" flag.
-- Additive only: one column with a default; no existing row is otherwise changed.
-- Starts CLOSED (fail closed): an owner or inventory admin opens season sales
-- in the dashboard (Ticket prices). Existing season bookings, tickets, payments
-- and gate admission are not affected by this switch.
-- Reverse with db/rollback/0010_down.sql.
ALTER TABLE festivals ADD COLUMN IF NOT EXISTS season_sales_open boolean NOT NULL DEFAULT false;
