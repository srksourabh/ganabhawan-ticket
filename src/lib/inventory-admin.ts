import { transaction, one, query, type Client } from './db';
import { AppError, requireValue } from './errors';
import { audit } from './audit';
import type { User } from './types';
import { ADMIN_POLICY } from './admin-policy';
import { zoneLabel } from './i18n';
import { assertSeasonFinalPrice, loadZonePrices, seasonPricing } from './pricing';

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

type CoveredSeason = { capacity_id: string; show_id: string; title: string; starts_at: string; status: string; pool_id: string; allocation: number; held: number; committed: number };

/** The SEASON pools of every non-cancelled performance a zone's All Together pass covers. */
async function coveredSeasonPools(c: Client | undefined, productId: string, lock = false) {
  const sql = `SELECT cap.id capacity_id, s.id show_id, s.title, s.starts_at, s.status, p.id pool_id, p.allocation, p.held, p.committed
     FROM product_coverage pc JOIN shows s ON s.id=pc.show_id JOIN pools p ON p.id=pc.pool_id JOIN capacities cap ON cap.id=p.capacity_id
     WHERE pc.product_id=$1 AND s.status<>'CANCELLED' ORDER BY s.starts_at, s.id${lock ? ' FOR UPDATE OF p, cap' : ''}`;
  return c ? (await c.query<CoveredSeason>(sql, [productId])).rows : query<CoveredSeason>(sql, [productId]);
}

/** Seats a pass can still sell: the lowest remaining online All Together seats over the programmes it covers. */
function passSeatsLeft(pools: CoveredSeason[]) {
  if (pools.length === 0) return { remaining: 0, lowest: null as null | { showId: string; title: string; remaining: number } };
  const left = pools.map((p) => ({ showId: p.show_id, title: p.title, remaining: Number(p.allocation) - Number(p.held) - Number(p.committed) }));
  const lowest = left.reduce((min, p) => (p.remaining < min.remaining ? p : min));
  return { remaining: Math.max(0, lowest.remaining), lowest };
}

/**
 * All Together seats per zone, for the inventory screen. A pass needs a seat in EVERY programme
 * it covers, so what it can still sell is the lowest remaining count among them (the same rule as
 * availability.ts remainingTickets): raising one performance alone never adds pass seats.
 */
export async function allTogetherSeats() {
  const passes = await query<{ id: string; category: string; name: string }>("SELECT id, category, name FROM products WHERE kind='SEASON' ORDER BY array_position(ARRAY['Premier','Superior','Balcony'], category)");
  const out = [];
  for (const pass of passes) {
    const pools = await coveredSeasonPools(undefined, pass.id);
    out.push({ zone: pass.category, label: zoneLabel('en', pass.category), productId: pass.id, programmes: pools.length, ...passSeatsLeft(pools) });
  }
  return out;
}

/**
 * Adds `seats` All Together seats for one zone: every programme the zone's pass covers gets
 * `seats` more seats set aside for All Together AND `seats` more sold online (a counter-only
 * reserve, if any, is kept). All programmes change or none do, under the commerce lock (the
 * same lock every hold takes, so no sale can interleave). A programme whose capacity has no room
 * (daily + All Together > capacity) is named in the refusal. `expectedAvailable` must equal the
 * seats left the admin saw, so a repeated or stale submission (double click, two admins) never
 * adds twice. Bookings, holds and daily stock are never touched.
 */
export async function addAllTogetherSeats(user: User, input: { zone?: unknown; seats?: unknown; expectedAvailable?: unknown }) {
  requireValue(user.role === 'owner' || (ADMIN_POLICY.inventory as readonly string[]).includes(user.role), 'You do not have permission for this action.', 403);
  const zone = String(input.zone ?? '');
  requireValue((ZONES as readonly string[]).includes(zone), 'Choose Front block, Second block or First floor.', 400);
  const seats = input.seats as number;
  requireValue(typeof seats === 'number' && Number.isInteger(seats) && seats >= 1 && seats <= 1000, 'Seats to add must be a whole number from 1 to 1000.', 400);
  const expected = input.expectedAvailable as number;
  requireValue(typeof expected === 'number' && Number.isInteger(expected) && expected >= 0, 'Refresh the page and try again.', 400);
  return transaction(async (c) => {
    const pass = await one<{ id: string }>(c, "SELECT id FROM products WHERE kind='SEASON' AND category=$1 ORDER BY id LIMIT 1 FOR UPDATE", [zone]);
    requireValue(pass, `There is no All Together pass for ${zoneLabel('en', zone)}. Create one under Seasons.`, 404);
    const pools = await coveredSeasonPools(c, pass!.id, true);
    requireValue(pools.length > 0, 'This All Together pass covers no programme. Include programmes under Dramas first.', 409);
    const before = passSeatsLeft(pools);
    requireValue(before.remaining === expected, `${zoneLabel('en', zone)} now has ${before.remaining} All Together seats left (you saw ${expected}). Refresh and try again; nothing was added.`, 409);
    for (const p of pools) {
      const cap = (await one<{ ceiling: number; season_allocation: number | null }>(c, 'SELECT ceiling, season_allocation FROM capacities WHERE id=$1', [p.capacity_id]))!;
      const daily = await one<{ allocation: number }>(c, "SELECT allocation FROM pools WHERE capacity_id=$1 AND kind='DAILY'", [p.capacity_id]);
      const online = Number(p.allocation);
      const setAside = Math.max(Number(cap.season_allocation ?? online), online);
      try {
        await applyCapacity(c, user, p.capacity_id, {
          ceiling: Number(cap.ceiling), dailyAllocation: Number(daily?.allocation ?? 0),
          seasonAllocation: setAside + seats, onlineSeasonAllocation: online + seats,
        });
      } catch (error) {
        if (error instanceof AppError) {
          throw new AppError(error.status, `${p.title} (${zoneLabel('en', zone)}): ${error.message} Raise its total capacity or lower its daily allocation first. Nothing was added.`, 'SEASON_SEATS_NO_ROOM');
        }
        throw error;
      }
    }
    const after = passSeatsLeft(await coveredSeasonPools(c, pass!.id));
    await audit(c, user.id, 'inventory.season.add_seats', pass!.id, { zone, seats, programmes: pools.length, before: before.remaining, after: after.remaining });
    return { zone, seats, programmes: pools.length, before: before.remaining, after: after.remaining };
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
    const shared = (await loadZonePrices(festival!.id, c))[category as Zone];
    assertSeasonFinalPrice(seasonPricing({ perProgrammePrice: shared.price, programmeCount: pools.length, finalPrice: price, configured: shared.configured }));
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
  // The daily price is the zone's shared per-programme price when one is configured (pricing.ts).
  const shared = await loadZonePrices(festivalId, c);
  return ZONES.map((zone) => {
    const row = rows.find((r) => r.zone === zone);
    const price = shared[zone].configured ? shared[zone].price! : Number(row?.price ?? 0);
    return row
      ? { zone, ceiling: Number(row.ceiling), seasonAllocation: row.season_allocation, daily: Number(row.daily ?? 0), season: Number(row.season ?? 0), price, enabled: true }
      : { zone, ceiling: 0, seasonAllocation: 0, daily: 0, season: 0, price, enabled: false };
  });
}

/**
 * Explicit admin action: add one performance to an All Together (season) pass's coverage.
 * New performances never join a pass by themselves (upsertShow). Only NEW purchases cover it:
 * every existing booking keeps its own snapshot, allocations and entitlements (existing holders
 * gain a programme only through programme-inclusion.ts amendExistingPasses). The product
 * version is bumped, so carts holding the old pass must re-add it (and see the new coverage).
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
    const pool = await one<{ id: string }>(c,
      `SELECT p.id FROM pools p JOIN capacities cap ON cap.id=p.capacity_id WHERE cap.show_id=$1 AND cap.zone=$2 AND p.kind='SEASON'`, [show!.id, product!.category]);
    requireValue(pool, 'This performance has no season stock for that zone.', 409);
    await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [product!.id, show!.id, pool!.id]);
    await c.query('UPDATE products SET version=version+1 WHERE id=$1', [product!.id]);
    await audit(c, user.id, 'product.season.add_show', product!.id, { showId: show!.id });
    return { productId: product!.id, showId: show!.id };
  }, true);
}
