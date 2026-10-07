-- 0007: one payment for a multi-ticket cart. Additive only.
-- A checkout groups the bookings created from one cart (still one booking per
-- ticket type). One Razorpay order and one payment belong to the checkout; its
-- total is the server-computed sum of its bookings. Existing single-booking
-- attempts/payments are untouched (booking_id set, checkout_id NULL), and the
-- pre-0007 application keeps working on this schema.
-- Reverse with db/rollback/0007_down.sql (refuses once any checkout exists).
-- PRODUCTION: apply (with a Neon backup branch) BEFORE merging code that uses it;
-- the main-branch deploy workflow does not run migrations.

CREATE TABLE IF NOT EXISTS checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  total int NOT NULL CHECK (total > 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkouts_owner ON checkouts(user_id, created_at DESC);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checkout_id uuid REFERENCES checkouts(id);
CREATE INDEX IF NOT EXISTS bookings_checkout ON bookings(checkout_id) WHERE checkout_id IS NOT NULL;

-- A payment attempt (provider order) targets exactly one booking OR one checkout.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS checkout_id uuid REFERENCES checkouts(id);
ALTER TABLE payment_attempts ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempt_target;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_target CHECK ((booking_id IS NULL) <> (checkout_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS payment_open_checkout_attempt ON payment_attempts(checkout_id)
  WHERE checkout_id IS NOT NULL AND state IN ('CREATING','READY','UNCERTAIN');

-- A captured payment belongs to exactly one booking OR one checkout.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_id uuid REFERENCES checkouts(id);
ALTER TABLE payments ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payment_target;
ALTER TABLE payments ADD CONSTRAINT payment_target CHECK ((booking_id IS NULL) <> (checkout_id IS NULL));
CREATE INDEX IF NOT EXISTS payments_checkout ON payments(checkout_id) WHERE checkout_id IS NOT NULL;
