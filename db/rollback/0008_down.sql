-- Manual reversal of 0008_allocations_scan_audit.sql. Not applied by db:migrate.
-- Drops the configured season allocations and the scan reporting columns; pools,
-- bookings, tickets and admissions are untouched.
BEGIN;
DROP TRIGGER IF EXISTS capacity_allocations_on_pool ON pools;
DROP TRIGGER IF EXISTS capacity_allocations_on_capacity ON capacities;
DROP FUNCTION IF EXISTS check_capacity_allocations();
ALTER TABLE capacities DROP CONSTRAINT IF EXISTS capacities_season_allocation_check;
ALTER TABLE capacities DROP COLUMN IF EXISTS season_allocation;
DROP INDEX IF EXISTS scan_requests_actor_time;
DROP INDEX IF EXISTS scan_requests_show_time;
ALTER TABLE scan_requests DROP COLUMN IF EXISTS code;
ALTER TABLE scan_requests DROP COLUMN IF EXISTS outcome;
ALTER TABLE scan_requests DROP COLUMN IF EXISTS ticket_id;
ALTER TABLE scan_requests DROP COLUMN IF EXISTS device_id;
ALTER TABLE scan_requests DROP COLUMN IF EXISTS gate;
ALTER TABLE scan_requests DROP COLUMN IF EXISTS show_id;
DELETE FROM schema_migrations WHERE name = '0008_allocations_scan_audit.sql';
COMMIT;
