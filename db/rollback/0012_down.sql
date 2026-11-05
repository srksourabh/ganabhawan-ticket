-- Manual reversal of 0012_zone_prices.sql. Not applied by db:migrate.
-- Drops only the shared per-programme price table. Daily product prices (already synced copies),
-- season prices, bookings, payments and inventory are untouched; the code then derives the
-- per-programme price from the daily products again.
BEGIN;
DROP TABLE IF EXISTS zone_prices;
DELETE FROM schema_migrations WHERE name = '0012_zone_prices.sql';
COMMIT;
