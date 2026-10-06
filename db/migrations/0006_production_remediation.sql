-- 0006: production remediation. Additive only: no data is deleted or rewritten
-- except the backfills below, and every new column is nullable or defaulted.
-- Reverse with db/rollback/0006_down.sql (see docs/RUNBOOK.md).

-- Staff MFA enrolment: pending secret until the staff member proves a code,
-- enabled timestamp, and the last accepted TOTP step (replay protection).
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step bigint;
UPDATE users SET mfa_enabled_at = now() WHERE mfa_secret IS NOT NULL AND mfa_enabled_at IS NULL;

-- Fair payment reconciliation: each attempt carries its own next check time,
-- so abandoned orders back off and can never starve newer ones.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS reconcile_checks int NOT NULL DEFAULT 0;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS next_reconcile_at timestamptz DEFAULT now();
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;
CREATE INDEX IF NOT EXISTS payment_attempts_reconcile
  ON payment_attempts(next_reconcile_at) WHERE state = 'READY' AND next_reconcile_at IS NOT NULL;

-- Refund status polling.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Ticket holder name captured at checkout.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS holder_name text;
UPDATE bookings b SET holder_name = a.name
  FROM booking_attempts a
  WHERE a.booking_id = b.id AND b.holder_name IS NULL AND a.user_id = b.user_id;

-- REFUNDED: a REFUND_REQUIRED booking whose refunds the provider has processed.
-- Superset of the previous values, so every existing row stays valid.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('HELD','PAYMENT_PENDING','CONFIRMED','EXPIRED','REFUND_REQUIRED','REFUNDED','CANCELLED'));
