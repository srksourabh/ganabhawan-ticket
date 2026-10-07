-- Manual reversal of 0007_checkouts.sql. Not applied by db:migrate.
-- Refuses to run once any checkout exists: those payments/attempts have no
-- booking_id and cannot be represented by the pre-0007 schema. In that case
-- roll back the application only (see RUNBOOK) and keep the schema.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM checkouts) THEN
    RAISE EXCEPTION 'checkouts exist: schema rollback would orphan multi-ticket payments';
  END IF;
END $$;
DROP INDEX IF EXISTS payments_checkout;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payment_target;
ALTER TABLE payments ALTER COLUMN booking_id SET NOT NULL;
ALTER TABLE payments DROP COLUMN IF EXISTS checkout_id;
DROP INDEX IF EXISTS payment_open_checkout_attempt;
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempt_target;
ALTER TABLE payment_attempts ALTER COLUMN booking_id SET NOT NULL;
ALTER TABLE payment_attempts DROP COLUMN IF EXISTS checkout_id;
DROP INDEX IF EXISTS bookings_checkout;
ALTER TABLE bookings DROP COLUMN IF EXISTS checkout_id;
DROP TABLE IF EXISTS checkouts;
DELETE FROM schema_migrations WHERE name = '0007_checkouts.sql';
COMMIT;
