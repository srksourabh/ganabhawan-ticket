import { query, transaction, one, type Client } from './db';
import { AppError, requireValue } from './errors';
import { audit } from './audit';
import { ADMIN_POLICY } from './admin-policy';
import { zoneLabel } from './i18n';
import type { User } from './types';

/**
 * ONE per-programme price per zone (migration 0012, table zone_prices), shared by:
 *
 *   Daily ticket      pays the per-programme price (no discount, ever). The daily products'
 *                     `price` is a copy, rewritten for every upcoming programme by setZonePrice
 *                     (holds, carts and payments keep reading products.price, as before).
 *   All together      pays the admin's FINAL price (the season product's `price`, as before).
 *                     Its ORIGINAL total = per-programme price × programmes it covers, computed
 *                     here and never stored, so a base-price change re-prices it everywhere.
 *
 * The server alone computes every amount; the browser only sends product id, quantity and version.
 * A final price above the original total is never sold (seasonPricing().blocked).
 */
export const PRICING_ZONES = ['Premier', 'Superior', 'Balcony'] as const;
export type PricingZone = (typeof PRICING_ZONES)[number];

export interface ZonePrice {
  zone: PricingZone;
  /** Paise per programme; null when nothing is configured or on sale for the zone. */
  price: number | null;
  /** True when set in zone_prices (admin or migration); false when derived from the daily products. */
  configured: boolean;
  version: number | null;
  updatedAt: string | null;
}

export interface SeasonPricing {
  perProgrammePrice: number | null;
  programmeCount: number;
  /** perProgrammePrice × programmeCount (null without a per-programme price). */
  originalTotal: number | null;
  finalPrice: number;
  /** originalTotal − finalPrice (0 when there is no original total or no saving). */
  discountAmount: number;
  /** discountAmount ÷ originalTotal × 100, two decimals (33.33). */
  discountPercent: number;
  /** Show "₹500 × 12 programmes", the struck-through original and the saving. */
  showDiscount: boolean;
  /** Configured base price makes the final price higher than the original: no new sale. */
  blocked: boolean;
  problem: string | null;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

/** (discount ÷ original) × 100, rounded to two decimals: 2000/6000 → 33.33. */
export function discountPercent(discount: number, original: number) {
  if (!(original > 0) || !(discount > 0)) return 0;
  return Math.round((discount / original) * 10000) / 100;
}

/**
 * The All together price breakdown. Pure: the same function prices the catalogue, the admin
 * table, the hold (commerce.ts placeHold) and the booking snapshot.
 *
 * `configured` = the per-programme price is the admin's (zone_prices). Only then can the
 * configuration be invalid: a derived price (no row yet) is shown, never enforced.
 */
export function seasonPricing(input: { perProgrammePrice: number | null; programmeCount: number; finalPrice: number; configured: boolean }): SeasonPricing {
  const finalPrice = Number(input.finalPrice);
  const count = Math.max(0, Math.trunc(input.programmeCount));
  const per = input.perProgrammePrice === null ? null : Number(input.perProgrammePrice);
  const originalTotal = per === null || count === 0 ? null : per * count;
  const discountAmount = originalTotal !== null && originalTotal > finalPrice ? originalTotal - finalPrice : 0;
  const blocked = input.configured && originalTotal !== null && finalPrice > originalTotal;
  return {
    perProgrammePrice: per,
    programmeCount: count,
    originalTotal,
    finalPrice,
    discountAmount,
    discountPercent: originalTotal === null ? 0 : discountPercent(discountAmount, originalTotal),
    showDiscount: !blocked && discountAmount > 0,
    blocked,
    problem: blocked
      ? `The All together price ${rupees(finalPrice)} is more than the original total ${rupees(originalTotal!)} (${rupees(per!)} × ${count} programmes). Lower the All together price.`
      : null,
  };
}

/** What a booking stores about its price (bookings.snapshot.pricing), per ticket, in paise. */
export interface PricingSnapshot {
  zone: string;
  zoneName: string;
  kind: 'DAILY' | 'SEASON';
  perProgrammePrice: number | null;
  programmeCount: number;
  originalTotal: number | null;
  discountAmount: number;
  discountPercent: number;
  finalPrice: number;
  pricingVersion: number | null;
}

export function dailyPricingSnapshot(zone: string, price: number, pricingVersion: number | null): PricingSnapshot {
  return {
    zone, zoneName: zoneLabel('en', zone), kind: 'DAILY', perProgrammePrice: price, programmeCount: 1,
    originalTotal: price, discountAmount: 0, discountPercent: 0, finalPrice: price, pricingVersion,
  };
}

export function seasonPricingSnapshot(zone: string, pricing: SeasonPricing, pricingVersion: number | null): PricingSnapshot {
  return {
    zone, zoneName: zoneLabel('en', zone), kind: 'SEASON', perProgrammePrice: pricing.perProgrammePrice, programmeCount: pricing.programmeCount,
    originalTotal: pricing.originalTotal, discountAmount: pricing.discountAmount, discountPercent: pricing.discountPercent,
    finalPrice: pricing.finalPrice, pricingVersion,
  };
}

type Runner = Client | undefined;
async function rows<T>(c: Runner, sql: string, params: unknown[] = []): Promise<T[]> {
  return c ? (await c.query(sql, params)).rows as T[] : query<T>(sql, params);
}

/** Whether migration 0012 is applied (the code keeps working before it is). */
export async function zonePricesReady(c?: Client) {
  const [row] = await rows<{ ok: boolean }>(c, "SELECT to_regclass('public.zone_prices') IS NOT NULL ok");
  return row?.ok === true;
}

/**
 * The per-programme price of every zone for a festival: the zone_prices row when there is one,
 * otherwise the most common daily price of the upcoming programmes (what is on sale).
 */
export async function loadZonePrices(festivalId: string, c?: Client): Promise<Record<PricingZone, ZonePrice>> {
  const configured = (await zonePricesReady(c))
    ? await rows<{ zone: PricingZone; price: number; version: number; updated_at: string }>(c,
      'SELECT zone, price, version, updated_at FROM zone_prices WHERE festival_id=$1', [festivalId])
    : [];
  const derived = await rows<{ zone: PricingZone; price: number }>(c,
    `SELECT DISTINCT ON (p.category) p.category zone, p.price FROM products p JOIN shows s ON s.id=p.show_id
     WHERE p.festival_id=$1 AND p.kind='DAILY' AND p.price>0 AND s.status<>'CANCELLED' AND s.ends_at>now()
     GROUP BY p.category, p.price ORDER BY p.category, count(*) DESC, p.price DESC`, [festivalId]);
  const out = {} as Record<PricingZone, ZonePrice>;
  for (const zone of PRICING_ZONES) {
    const row = configured.find((r) => r.zone === zone);
    const fallback = derived.find((r) => r.zone === zone);
    out[zone] = row
      ? { zone, price: Number(row.price), configured: true, version: Number(row.version), updatedAt: new Date(row.updated_at).toISOString() }
      : { zone, price: fallback ? Number(fallback.price) : null, configured: false, version: null, updatedAt: null };
  }
  return out;
}

/** The All together breakdown of one season product (non-cancelled programmes it covers). */
export async function seasonProductPricing(c: Client | undefined, product: { id: string; festival_id: string; category: string; price: number }) {
  const prices = await loadZonePrices(product.festival_id, c);
  const zone = prices[product.category as PricingZone];
  const [count] = await rows<{ n: number }>(c,
    "SELECT count(*)::int n FROM product_coverage pc JOIN shows s ON s.id=pc.show_id WHERE pc.product_id=$1 AND s.status<>'CANCELLED'", [product.id]);
  return {
    pricing: seasonPricing({ perProgrammePrice: zone?.price ?? null, programmeCount: Number(count?.n ?? 0), finalPrice: Number(product.price), configured: zone?.configured ?? false }),
    version: zone?.version ?? null,
  };
}

/**
 * An admin-entered final All together price must not exceed the original total (when the
 * per-programme price is configured). Used by create / edit of a season product.
 */
export function assertSeasonFinalPrice(pricing: SeasonPricing) {
  if (pricing.blocked) throw new AppError(400, pricing.problem!, 'SEASON_PRICE_ABOVE_ORIGINAL');
}

function assertPricingRole(user: User) {
  requireValue(user.role === 'owner' || (ADMIN_POLICY.catalogue as readonly string[]).includes(user.role), 'You do not have permission for this action.', 403);
}

/**
 * Sets a zone's per-programme price and copies it to the daily ticket of every upcoming,
 * not cancelled programme in that zone (their version goes up, so a cart holding the old
 * price is asked to refresh, exactly as an individual price edit always did). Season final
 * prices are NOT changed: their original total and discount follow automatically, and a
 * final price that is now above the original total is flagged (and not sold) until lowered.
 * Bookings already made keep the price they were made at (bookings.unit_price / snapshot).
 */
export async function setZonePrice(user: User, input: Record<string, unknown>) {
  assertPricingRole(user);
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Send the zone and its price.', 400);
  const zone = String(input.zone ?? '') as PricingZone;
  requireValue(PRICING_ZONES.includes(zone), 'Choose Front block, Second block or First floor.', 400);
  const price = input.price as number;
  requireValue(typeof price === 'number' && Number.isInteger(price) && price > 0 && price <= 10_000_000, 'Price per programme must be a positive whole number of paise.', 400);
  const expected = input.version === undefined || input.version === null ? null : Number(input.version);
  return transaction(async (c) => {
    requireValue(await zonePricesReady(c), 'Shared prices need database migration 0012. Ask the operator to run it.', 409);
    const festival = await one<{ id: string }>(c, 'SELECT id FROM festivals ORDER BY created_at LIMIT 1');
    requireValue(festival, 'Create the festival first.', 404);
    const current = await one<{ price: number; version: number }>(c, 'SELECT price, version FROM zone_prices WHERE festival_id=$1 AND zone=$2 FOR UPDATE', [festival!.id, zone]);
    if (current && expected !== null) requireValue(Number(current.version) === expected, 'This price was changed by someone else. Refresh and try again.', 409);
    const saved = (await one<{ version: number; updated_at: string }>(c,
      `INSERT INTO zone_prices(festival_id, zone, price, updated_by) VALUES($1,$2,$3,$4)
       ON CONFLICT (festival_id, zone) DO UPDATE SET price=EXCLUDED.price, version=zone_prices.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by
       RETURNING version, updated_at`, [festival!.id, zone, price, user.id]))!;
    const daily = await c.query<{ id: string }>(
      `UPDATE products SET price=$1, version=version+1
       WHERE festival_id=$2 AND kind='DAILY' AND category=$3 AND price<>$1
         AND show_id IN (SELECT id FROM shows WHERE festival_id=$2 AND status<>'CANCELLED' AND ends_at>now())
       RETURNING id`, [price, festival!.id, zone]);
    await audit(c, user.id, 'pricing.zone.update', `${festival!.id}:${zone}`, {
      zone, before: current ? Number(current.price) : null, after: price, dailyProductsUpdated: daily.rows.length,
    });
    return { zone, price, version: Number(saved.version), updatedAt: new Date(saved.updated_at).toISOString(), dailyProductsUpdated: daily.rows.length };
  }, true);
}

/**
 * A daily product's price is the zone's shared per-programme price. Once that is configured,
 * a different price for one programme is refused (it would create a second source of truth).
 */
export async function assertDailyPriceShared(c: Client, festivalId: string, zone: string, price: number) {
  if (!(await zonePricesReady(c))) return;
  const row = await one<{ price: number }>(c, 'SELECT price FROM zone_prices WHERE festival_id=$1 AND zone=$2', [festivalId, zone]);
  if (!row || Number(row.price) === price) return;
  throw new AppError(409,
    `${zoneLabel('en', zone)} daily tickets cost the shared price of ${rupees(Number(row.price))} per programme. Change it under Ticket prices → Price per programme.`,
    'DAILY_PRICE_SHARED');
}

/** One zone of the admin All together table; only `zone`, `label` and `productId: null` when the zone has no pass. */
export interface AllTogetherRow extends Partial<SeasonPricing> {
  zone: PricingZone;
  label: string;
  productId: string | null;
  name?: string;
  enabled?: boolean;
  version?: number;
  updatedAt?: string | null;
  /** The programmes the pass covers (not cancelled), in date order: what programmeCount counts. */
  programmes?: { id: string; title: string; startsAt: string }[];
  /** Published, upcoming programmes the pass does NOT cover (never added automatically: see addShowToSeason). */
  missingProgrammes?: { id: string; title: string; startsAt: string }[];
}

/** Everything the admin "Ticket prices" screen shows. */
export async function pricingOverview(user: User) {
  assertPricingRole(user);
  const festival = (await query<{ id: string }>('SELECT id FROM festivals ORDER BY created_at LIMIT 1'))[0];
  if (!festival) return { ready: false, zones: [], allTogether: [] as AllTogetherRow[] };
  const ready = await zonePricesReady();
  const prices = await loadZonePrices(festival.id);
  const seasons = await query<{ id: string; name: string; category: string; price: number; version: number; enabled: boolean; festival_id: string; programmes: number; updated_at: string | null }>(
    `SELECT p.id, p.name, p.category, p.price, p.version, p.enabled, p.festival_id,
       (SELECT count(*)::int FROM product_coverage pc JOIN shows s ON s.id=pc.show_id WHERE pc.product_id=p.id AND s.status<>'CANCELLED') programmes,
       (SELECT max(a.created_at) FROM audit_events a WHERE a.entity=p.id::text AND (a.action IN ('product.season.create','product.update')
          OR (a.action='product.season.update' AND a.detail->'before'->'price' IS DISTINCT FROM a.detail->'after'->'price'))) updated_at
     FROM products p WHERE p.festival_id=$1 AND p.kind='SEASON'`, [festival.id]);
  type Programme = { id: string; title: string; starts_at: string; product_id: string | null };
  const covered = await query<Programme>(
    `SELECT s.id, s.title, s.starts_at, pc.product_id FROM product_coverage pc JOIN shows s ON s.id=pc.show_id JOIN products p ON p.id=pc.product_id
     WHERE p.festival_id=$1 AND p.kind='SEASON' AND s.status<>'CANCELLED' ORDER BY s.starts_at, s.id`, [festival.id]);
  const published = await query<Programme>(
    `SELECT s.id, s.title, s.starts_at, NULL product_id FROM shows s WHERE s.festival_id=$1 AND s.status='PUBLISHED' AND s.ends_at>now() ORDER BY s.starts_at, s.id`, [festival.id]);
  const view = (r: Programme) => ({ id: r.id, title: r.title, startsAt: new Date(r.starts_at).toISOString() });
  return {
    ready,
    zones: PRICING_ZONES.map((zone) => ({ ...prices[zone], label: zoneLabel('en', zone) })),
    allTogether: PRICING_ZONES.map((zone): AllTogetherRow => {
      const s = seasons.find((r) => r.category === zone);
      if (!s) return { zone, label: zoneLabel('en', zone), productId: null };
      const pricing = seasonPricing({ perProgrammePrice: prices[zone].price, programmeCount: Number(s.programmes), finalPrice: Number(s.price), configured: prices[zone].configured });
      const mine = covered.filter((r) => r.product_id === s.id);
      return {
        zone, label: zoneLabel('en', zone), productId: s.id, name: s.name, enabled: s.enabled, version: Number(s.version),
        updatedAt: s.updated_at ? new Date(s.updated_at).toISOString() : null, ...pricing,
        programmes: mine.map(view),
        missingProgrammes: published.filter((p) => !mine.some((m) => m.id === p.id)).map(view),
      };
    }),
  };
}
