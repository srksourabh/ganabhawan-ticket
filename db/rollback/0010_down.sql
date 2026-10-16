ALTER TABLE booking_attempts DROP COLUMN IF EXISTS phone;
ALTER TABLE booking_attempts DROP COLUMN IF EXISTS email;
ALTER TABLE bookings DROP COLUMN IF EXISTS holder_phone;
ALTER TABLE bookings DROP COLUMN IF EXISTS holder_email;
ALTER TABLE shows DROP COLUMN IF EXISTS sales_closes_at;
ALTER TABLE festivals DROP COLUMN IF EXISTS season_closes_at;
ALTER TABLE festivals DROP COLUMN IF EXISTS booking_opens_at;
