-- 0012: one per-programme price per zone, shared by daily tickets and the "All together" pass.
-- Additive only: one new table. No existing row is changed: products, bookings, payments and
-- inventory are untouched. Zone ids stay 'Premier' / 'Superior' / 'Balcony' (display names
-- live in the code: src/lib/i18n.ts zoneLabel).
--
--   zone_prices.price       paise per programme for the zone (e.g. 50000 = ₹500)
--   daily products          a copy, rewritten for every upcoming programme when this changes (pricing.ts)
--   season product price    the admin's FINAL "All together" price (unchanged meaning)
--   original total          zone_prices.price × programmes the pass covers (computed, never stored)
--
-- Seeded from what is on sale today: for each zone, the most common daily price of the upcoming,
-- not cancelled programmes (production: one price per zone, so this is exactly that price).
-- The code works without this table (it derives the same value from the daily products) and
-- without rows (same). Reverse with db/rollback/0012_down.sql.
CREATE TABLE IF NOT EXISTS zone_prices (
  festival_id uuid NOT NULL REFERENCES festivals(id),
  zone text NOT NULL CHECK (zone IN ('Premier','Superior','Balcony')),
  price int NOT NULL CHECK (price > 0),
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (festival_id, zone)
);

INSERT INTO zone_prices(festival_id, zone, price)
SELECT DISTINCT ON (p.festival_id, p.category) p.festival_id, p.category, p.price
FROM products p JOIN shows s ON s.id = p.show_id
WHERE p.kind = 'DAILY' AND p.price > 0 AND s.status <> 'CANCELLED' AND s.ends_at > now()
GROUP BY p.festival_id, p.category, p.price
ORDER BY p.festival_id, p.category, count(*) DESC, p.price DESC
ON CONFLICT (festival_id, zone) DO NOTHING;
