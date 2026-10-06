-- Manual reversal of 0006_production_remediation.sql. Not applied by db:migrate.
-- The application at 4e5663f runs correctly against the 0006 schema (all
-- additions are ignored), so an app rollback does NOT require this file.
-- Only run it if the schema itself must be reverted, inside one transaction.
BEGIN;
-- REFUNDED is not a valid state before 0006; map it back first.
UPDATE bookings SET status = 'REFUND_REQUIRED' WHERE status = 'REFUNDED';
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('HELD','PAYMENT_PENDING','CONFIRMED','EXPIRED','REFUND_REQUIRED','CANCELLED'));
ALTER TABLE bookings DROP COLUMN IF EXISTS holder_name;
ALTER TABLE refunds DROP COLUMN IF EXISTS updated_at;
ALTER TABLE refunds DROP COLUMN IF EXISTS last_checked_at;
DROP INDEX IF EXISTS payment_attempts_reconcile;
ALTER TABLE payment_attempts DROP COLUMN IF EXISTS last_reconciled_at;
ALTER TABLE payment_attempts DROP COLUMN IF EXISTS next_reconcile_at;
ALTER TABLE payment_attempts DROP COLUMN IF EXISTS reconcile_checks;
-- Dropping these disables MFA for staff enrolled via db:staff; mfa_secret is kept.
ALTER TABLE users DROP COLUMN IF EXISTS mfa_last_step;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_enabled_at;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_pending_secret;
DELETE FROM schema_migrations WHERE name = '0006_production_remediation.sql';
COMMIT;
