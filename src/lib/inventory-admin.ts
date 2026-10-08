import { transaction, one, query, type Client } from './db';
import { AppError, requireValue } from './errors';
import { audit } from './audit';
import type { User } from './types';

/**
 * Admin-configured inventory for one show × zone (migration 0008):
 *
 *   ceiling                 total seats in the zone                  e.g. 300
 *   seasonAllocation        seats set aside for season tickets       e.g. 50
 *   dailyAllocation         daily tickets sold online (DAILY pool)    e.g. 250
 *   onlineSeasonAllocation  season tickets sold online (SEASON pool)  e.g. 20
 *
 * Daily and season tickets draw from separate pools, so neither can oversell the
 * other. A season ticket takes one seat from the SEASON pool of every show it
 * covers. All checks run under the commerce lock, the same lock every hold takes.
 */
export const ZONES = ['Premier', 'Superior', 'Balcony'] as const;
export type Zone = (typeof ZONES)[number];

export interface CapacityConfig {
  ceiling: number;
  seasonAllocation: number;
  dailyAllocation: number;
  onlineSeasonAllocation: number;
}

type PoolRow = { id: string; kind: 'DAILY' | 'SEASON'; allocation: number; held: number; committed: number; version: number };

function wholeNumber(value: unknown, label: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new AppError(400, `${label} must be a whole number of zero or more.`);
  return n;
}

/** Pure validation of one configuration against what is already sold or held. */
export function validateCapacityConfig(input: Partial<Record<keyof CapacityConfig, unknown>>, used: { daily: number; season: number }): CapacityConfig {
  const config: CapacityConfig = {
    ceiling: wholeNumber(input.ceiling, 'Total capacity'),
    seasonAllocation: wholeNumber(input.seasonAllocation, 'Season allocation'),
    dailyAllocation: wholeNumber(input.dailyAllocation, 'Daily allocation'),
    onlineSeasonAllocation: wholeNumber(input.onlineSeasonAllocation, 'Online season allocation'),
  };
  if (config.seasonAllocation + config.dailyAllocation > config.ceiling) {
    throw new AppError(400, `Season allocation (${config.seasonAllocation}) + daily allocation (${config.dailyAllocation}) cannot exceed the zone capacity (${config.ceiling}).`);
  }
  if (config.onlineSeasonAllocation > config.seasonAllocation) {
    throw new AppError(400, `Online season allocation (${config.onlineSeasonAllocation}) cannot exceed the season allocation (${config.seasonAllocation}).`);
  }
  if (config.dailyAllocation < used.daily) {
    throw new AppError(409, `Daily allocation cannot go below ${used.daily}: that many daily tickets are already sold or held.`);
  }
  if (config.onlineSeasonAllocation < used.season) {
    throw new AppError(409, `Online season allocation cannot go below ${used.season}: that many season tickets are already sold or held.`);
  }
  return config;
}

async function applyCapacity(c: Client, user: User, capacityId: string, input: Partial<Record<keyof CapacityConfig, unknown>>, version?: number) {
  const capacity = await one<{ id: string; show_id: string; zone: string; ceiling: number; season_allocation: number | null; version: number }>(
    c, 'SELECT * FROM capacities WHERE id=$1 FOR UPDATE', [capacityId]);
  requireValue(capacity, 'Zone not found.', 404);
  if (version !== undefined) requireValue(capacity!.version === version, 'This zone changed. Refresh and try again.');
  const pools = (await c.query<PoolRow>('SELECT * FROM pools WHERE capacity_id=$1 ORDER BY kind FOR UPDATE', [capacityId])).rows;
  const daily = pools.find((p) => p.kind === 'DAILY');
  const season = pools.find((p) => p.kind === 'SEASON');
  requireValue(daily && season, 'This zone has no daily/season inventory pools.', 409);
  const config = validateCapacityConfig(input, {
    daily: Number(daily!.held) + Number(daily!.committed),
    season: Number(season!.held) + Number(season!.committed),
  });
  await c.query('UPDATE capacities SET ceiling=$1, season_allocation=$2, version=version+1 WHERE id=$3', [config.ceiling, config.seasonAllocation, capacityId]);
  for (const [pool, allocation] of [[daily!, config.dailyAllocation], [season!, config.onlineSeasonAllocation]] as const) {
    if (Number(pool.allocation) === allocation) continue;
    await c.query('UPDATE pools SET allocation=$1, version=version+1 WHERE id=$2', [allocation, pool.id]);
    await c.query("INSERT INTO movements(pool_id,operation,delta_allocation,reason) VALUES($1,'configure',$2,$3)",
      [pool.id, allocation - Number(pool.allocation), `admin configuration by ${user.id}`]);
  }
  await audit(c, user.id, 'inventory.configure', capacityId, {
    showId: capacity!.show_id, zone: capacity!.zone,
    before: { ceiling: capacity!.ceiling, seasonAllocation: capacity!.season_allocation, dailyAllocation: daily!.allocation, onlineSeasonAllocation: season!.allocation },
    after: config,
  });
  return { capacityId, ...config };
}

/** One show × zone. `version` (optimistic) guards against two admins editing at once. */
export async function configureCapacity(user: User, capacityId: string, input: Partial<Record<keyof CapacityConfig, unknown>> & { version?: number }) {
  return transaction((c) => applyCapacity(c, user, capacityId, input, input.version === undefined ? undefined : Number(input.version)), true);
}

/**
 * Season allocation for a zone across every performance that has not ended
 * (a season ticket uses one seat in each). All shows change or none do.
 */
export async function configureSeasonForZone(user: User, zone: string, input: { seasonAllocation?: unknown; onlineSeasonAllocation?: unknown }) {
  requireValue((ZONES as readonly string[]).includes(zone), 'Unknown zone.', 400);
  return transaction(async (c) => {
    const rows = (await c.query<{ id: string; ceiling: number; daily: number }>(
      `SELECT cap.id, cap.ceiling, (SELECT allocation FROM pools WHERE capacity_id=cap.id AND kind='DAILY') daily
       FROM capacities cap JOIN shows s ON s.id=cap.show_id
       WHERE cap.zone=$1 AND s.status<>'CANCELLED' AND s.ends_at>now() ORDER BY s.starts_at`, [zone])).rows;
    requireValue(rows.length > 0, 'No upcoming performance has this zone.', 404);
    const results = [];
    for (const row of rows) {
      results.push(await applyCapacity(c, user, row.id, {
        ceiling: row.ceiling, dailyAllocation: row.daily,
        seasonAllocation: input.seasonAllocation, onlineSeasonAllocation: input.onlineSeasonAllocation,
      }));
    }
    return { zone, shows: results.length, results };
  }, true);
}

/** Everything the inventory screen shows, per show × zone, from the database. */
export async function inventoryOverview() {
  return query(`SELECT s.id show_id, s.title, s.starts_at, s.status show_status, cap.id capacity_id, cap.zone, cap.ceiling, cap.season_allocation, cap.version,
     d.allocation daily_allocation, (d.held + d.committed) daily_used, d.committed daily_sold,
     sp.allocation online_season_allocation, (sp.held + sp.committed) season_used, sp.committed season_sold,
     dp.id daily_product_id, dp.price daily_price, dp.enabled daily_enabled
   FROM capacities cap JOIN shows s ON s.id=cap.show_id
   LEFT JOIN pools d ON d.capacity_id=cap.id AND d.kind='DAILY'
   LEFT JOIN pools sp ON sp.capacity_id=cap.id AND sp.kind='SEASON'
   LEFT JOIN products dp ON dp.show_id=s.id AND dp.kind='DAILY' AND dp.category=cap.zone
   ORDER BY s.starts_at, array_position(ARRAY['Premier','Superior','Balcony'], cap.zone)`);
}

/**
 * Creates the season ticket for a zone, covering the SEASON pool of every
 * published performance that has not started. One season product per zone.
 */
export async function createSeasonProduct(user: User, input: { category?: unknown; name?: unknown; nameBn?: unknown; price?: unknown }) {
  const category = String(input.category ?? '');
  requireValue((ZONES as readonly string[]).includes(category), 'Choose a zone for the season ticket.', 400);
  const name = String(input.name ?? '').trim(), nameBn = String(input.nameBn ?? '').trim();
  requireValue(name && nameBn, 'Season ticket name (English and Bengali) is required.', 400);
  const price = Number(input.price);
  requireValue(Number.isInteger(price) && price > 0, 'Price must be a positive whole number of paise.', 400);
  return transaction(async (c) => {
    const festival = await one<{ id: string }>(c, 'SELECT id FROM festivals ORDER BY created_at LIMIT 1 FOR UPDATE');
    requireValue(festival, 'Create the festival first.', 404);
    const existing = await one(c, "SELECT id FROM products WHERE festival_id=$1 AND kind='SEASON' AND category=$2", [festival!.id, category]);
    requireValue(!existing, 'A season ticket already exists for this zone. Edit or disable it instead.', 409);
    const pools = (await c.query<{ show_id: string; pool_id: string }>(
      `SELECT s.id show_id, p.id pool_id FROM shows s JOIN capacities cap ON cap.show_id=s.id AND cap.zone=$2
       JOIN pools p ON p.capacity_id=cap.id AND p.kind='SEASON'
       WHERE s.festival_id=$1 AND s.status='PUBLISHED' AND s.starts_at>now() ORDER BY s.starts_at`, [festival!.id, category])).rows;
    requireValue(pools.length > 0, 'Publish at least one upcoming performance before creating a season ticket.', 409);
    const product = (await one<{ id: string }>(c,
      `INSERT INTO products(festival_id,name,name_bn,category,kind,price) VALUES($1,$2,$3,$4,'SEASON',$5) RETURNING *`,
      [festival!.id, name, nameBn, category, price]))!;
    for (const p of pools) await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [product.id, p.show_id, p.pool_id]);
    await audit(c, user.id, 'product.season.create', product.id, { category, price, shows: pools.length });
    return { ...product, coverage: pools.length };
  }, true);
}

/**
 * Zone setup for a new performance: copied from the most recent performance, so
 * the organiser configures capacity and prices once in the dashboard. With no
 * earlier performance, zones start empty (capacity 0) and their daily tickets
 * disabled until configured: nothing is sellable by default.
 */
export async function zoneTemplate(c: Client, festivalId: string, excludeShowId: string) {
  const rows = (await c.query<{ zone: Zone; ceiling: number; season_allocation: number | null; daily: number; season: number; price: number | null }>(
    `SELECT cap.zone, cap.ceiling, cap.season_allocation,
       (SELECT allocation FROM pools WHERE capacity_id=cap.id AND kind='DAILY') daily,
       (SELECT allocation FROM pools WHERE capacity_id=cap.id AND kind='SEASON') season,
       (SELECT price FROM products WHERE show_id=cap.show_id AND kind='DAILY' AND category=cap.zone LIMIT 1) price
     FROM capacities cap WHERE cap.show_id=(SELECT s.id FROM shows s WHERE s.festival_id=$1 AND s.id<>$2
       AND EXISTS (SELECT 1 FROM capacities x WHERE x.show_id=s.id) ORDER BY s.starts_at DESC LIMIT 1)`, [festivalId, excludeShowId])).rows;
  return ZONES.map((zone) => {
    const row = rows.find((r) => r.zone === zone);
    return row
      ? { zone, ceiling: Number(row.ceiling), seasonAllocation: row.season_allocation, daily: Number(row.daily ?? 0), season: Number(row.season ?? 0), price: Number(row.price ?? 0), enabled: true }
      : { zone, ceiling: 0, seasonAllocation: 0, daily: 0, season: 0, price: 0, enabled: false };
  });
}

/**
 * Explicit admin action: add one performance to a season ticket's coverage.
 * New performances never join a season by themselves (upsertShow). Refused once
 * the season ticket has any sale, hold or payment in progress, so what existing
 * season customers bought never changes. The product version is bumped, so carts
 * holding the old season ticket must re-add it (and see the new coverage).
 */
export async function addShowToSeason(user: User, productId: string, showId: string) {
  return transaction(async (c) => {
    const product = await one<{ id: string; kind: string; category: string }>(c, 'SELECT * FROM products WHERE id::text=$1 FOR UPDATE', [productId]);
    requireValue(product && product.kind === 'SEASON', 'Season ticket not found.', 404);
    const show = await one<{ id: string; status: string; starts_at: string }>(c, 'SELECT * FROM shows WHERE id::text=$1', [showId]);
    requireValue(show, 'Performance not found.', 404);
    requireValue(show!.status !== 'CANCELLED' && new Date(show!.starts_at).getTime() > Date.now(), 'Only an upcoming, not cancelled performance can be added.', 409);
    const covered = await one(c, 'SELECT 1 FROM product_coverage WHERE product_id=$1 AND show_id=$2', [product!.id, show!.id]);
    requireValue(!covered, 'This performance is already part of the season ticket.', 409);
    const sold = await one<{ n: number }>(c,
      "SELECT count(*)::int n FROM bookings WHERE product_id=$1 AND status IN ('HELD','PAYMENT_PENDING','CONFIRMED','REFUND_REQUIRED','REFUNDED')", [product!.id]);
    requireValue(Number(sold?.n ?? 0) === 0, 'This season ticket has already been sold or is being bought; its performances can no longer change.', 409);
    const pool = await one<{ id: string }>(c,
      `SELECT p.id FROM pools p JOIN capacities cap ON cap.id=p.capacity_id WHERE cap.show_id=$1 AND cap.zone=$2 AND p.kind='SEASON'`, [show!.id, product!.category]);
    requireValue(pool, 'This performance has no season stock for that zone.', 409);
    await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [product!.id, show!.id, pool!.id]);
    await c.query('UPDATE products SET version=version+1 WHERE id=$1', [product!.id]);
    await audit(c, user.id, 'product.season.add_show', product!.id, { showId: show!.id });
    return { productId: product!.id, showId: show!.id };
  }, true);
}
