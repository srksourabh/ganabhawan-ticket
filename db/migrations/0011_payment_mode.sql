-- 0011: the Razorpay environment (test or live) each payment order was created in.
-- Additive only: one nullable column; no existing row is changed. Orders created before this
-- migration keep NULL ("not recorded"; before Razorpay test mode was allowed in production they
-- were live). Recorded once, when the order is created (provider-order.ts), and never rewritten,
-- so a later switch of keys never reinterprets an existing payment.
-- The code works without it (nothing is recorded, everything is treated as before).
-- Reverse with db/rollback/0011_down.sql.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS provider_mode text;
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_provider_mode_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_provider_mode_check CHECK (provider_mode IS NULL OR provider_mode IN ('test', 'live'));
