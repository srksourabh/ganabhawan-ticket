-- Manual reversal of 0011_payment_mode.sql. Not applied by db:migrate.
-- Drops only the recorded Razorpay environment of payment orders; payments, bookings and tickets
-- are untouched. Without it the code treats every payment as "mode not recorded".
BEGIN;
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_provider_mode_check;
ALTER TABLE payment_attempts DROP COLUMN IF EXISTS provider_mode;
DELETE FROM schema_migrations WHERE name = '0011_payment_mode.sql';
COMMIT;
