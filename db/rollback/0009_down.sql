-- Manual reversal of 0009_account_cart_contacts.sql. Not applied by db:migrate.
-- Drops saved carts (unpaid selections only), the merge ledger, the notification
-- ledger and verified mobiles. Bookings, payments and tickets are untouched.
BEGIN;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS cart_merges;
DROP TABLE IF EXISTS cart_items;
DROP INDEX IF EXISTS users_verified_mobile_unique;
ALTER TABLE users DROP COLUMN IF EXISTS mobile_verified_at;
ALTER TABLE users DROP COLUMN IF EXISTS verified_mobile;
DELETE FROM schema_migrations WHERE name = '0009_account_cart_contacts.sql';
COMMIT;
