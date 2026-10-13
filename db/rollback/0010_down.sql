-- Manual reversal of 0010_season_sales_switch.sql. Not applied by db:migrate.
-- Drops only the season-sales switch. Without the column the code treats season
-- sales as closed (fail closed). Bookings, payments and tickets are untouched.
BEGIN;
ALTER TABLE festivals DROP COLUMN IF EXISTS season_sales_open;
DELETE FROM schema_migrations WHERE name = '0010_season_sales_switch.sql';
COMMIT;
