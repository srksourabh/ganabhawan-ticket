-- 0008: admin-configured season allocation and a reportable scan log.
-- Additive only: new nullable columns, a validation trigger and indexes. No row
-- is deleted; existing bookings, pools and scans stay valid.
-- Reverse with db/rollback/0008_down.sql.

-- Per show × zone the organiser decides:
--   capacities.ceiling            total seats in the zone             (e.g. 300)
--   capacities.season_allocation  seats set aside for season tickets  (e.g. 50; NULL = not configured)
--   pools[DAILY].allocation       daily tickets sold online            (e.g. 250)
--   pools[SEASON].allocation      season tickets sold ONLINE           (e.g. 20)
-- Invariants (enforced below for every change, and by configureCapacity):
--   daily allocation + season allocation <= ceiling
--   online season allocation <= season allocation
--   held + committed <= allocation (existing pools CHECK)
ALTER TABLE capacities ADD COLUMN IF NOT EXISTS season_allocation int;
ALTER TABLE capacities DROP CONSTRAINT IF EXISTS capacities_season_allocation_check;
ALTER TABLE capacities ADD CONSTRAINT capacities_season_allocation_check
  CHECK (season_allocation IS NULL OR (season_allocation >= 0 AND season_allocation <= ceiling));

CREATE OR REPLACE FUNCTION check_capacity_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap_id uuid;
  cap capacities%ROWTYPE;
  daily int;
  online_season int;
BEGIN
  -- (IF, not CASE: plpgsql resolves NEW.capacity_id even in an untaken CASE branch.)
  IF TG_TABLE_NAME = 'capacities' THEN cap_id := NEW.id; ELSE cap_id := NEW.capacity_id; END IF;
  SELECT * INTO cap FROM capacities WHERE id = cap_id;
  IF cap.season_allocation IS NULL THEN RETURN NEW; END IF; -- legacy rows: not configured yet
  SELECT COALESCE(max(allocation) FILTER (WHERE kind = 'DAILY'), 0),
         COALESCE(max(allocation) FILTER (WHERE kind = 'SEASON'), 0)
    INTO daily, online_season FROM pools WHERE capacity_id = cap_id;
  IF daily + cap.season_allocation > cap.ceiling THEN
    RAISE EXCEPTION 'ALLOCATION: daily allocation (%) + season allocation (%) exceeds zone capacity (%)', daily, cap.season_allocation, cap.ceiling
      USING ERRCODE = 'check_violation';
  END IF;
  IF online_season > cap.season_allocation THEN
    RAISE EXCEPTION 'ALLOCATION: online season allocation (%) exceeds season allocation (%)', online_season, cap.season_allocation
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capacity_allocations_on_capacity ON capacities;
CREATE CONSTRAINT TRIGGER capacity_allocations_on_capacity AFTER INSERT OR UPDATE ON capacities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_capacity_allocations();
DROP TRIGGER IF EXISTS capacity_allocations_on_pool ON pools;
CREATE CONSTRAINT TRIGGER capacity_allocations_on_pool AFTER INSERT OR UPDATE OF allocation ON pools
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_capacity_allocations();

-- Scan log for reporting: who scanned what, where, and the outcome. Existing rows
-- keep NULLs (their result jsonb is unchanged).
ALTER TABLE scan_requests ADD COLUMN IF NOT EXISTS show_id uuid;
ALTER TABLE scan_requests ADD COLUMN IF NOT EXISTS gate text;
ALTER TABLE scan_requests ADD COLUMN IF NOT EXISTS device_id text;
ALTER TABLE scan_requests ADD COLUMN IF NOT EXISTS ticket_id uuid;
ALTER TABLE scan_requests ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE scan_requests ADD COLUMN IF NOT EXISTS code text;
CREATE INDEX IF NOT EXISTS scan_requests_show_time ON scan_requests(show_id, created_at);
CREATE INDEX IF NOT EXISTS scan_requests_actor_time ON scan_requests(actor_id, created_at);
