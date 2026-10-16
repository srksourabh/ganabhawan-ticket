-- 0010: when tickets may be sold, and the name, email and phone collected at checkout.
-- Additive. Reverse with db/rollback/0010_down.sql.

ALTER TABLE festivals ADD COLUMN IF NOT EXISTS booking_opens_at timestamptz;
ALTER TABLE festivals ADD COLUMN IF NOT EXISTS season_closes_at timestamptz;
UPDATE festivals SET season_closes_at = TIMESTAMPTZ '2026-12-19 19:00:00+05:30' WHERE season_closes_at IS NULL;
ALTER TABLE festivals ALTER COLUMN season_closes_at SET DEFAULT TIMESTAMPTZ '2026-12-19 19:00:00+05:30';
ALTER TABLE festivals ALTER COLUMN season_closes_at SET NOT NULL;

ALTER TABLE shows ADD COLUMN IF NOT EXISTS sales_closes_at timestamptz;
UPDATE shows
   SET sales_closes_at = ((starts_at AT TIME ZONE 'Asia/Kolkata')::date + time '19:00') AT TIME ZONE 'Asia/Kolkata'
 WHERE sales_closes_at IS NULL;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS holder_email text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS holder_phone text;

ALTER TABLE booking_attempts ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE booking_attempts ADD COLUMN IF NOT EXISTS phone text;
