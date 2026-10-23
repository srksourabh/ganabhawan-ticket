import { query, transaction, one } from './db';
import { audit } from './audit';
import { requireValue } from './errors';
import { configurationProblems, publicSalesOpen } from './env';
import { performanceAvailability, zoneAvailability, type PerformanceAvailability, type ZoneAvailability } from './availability';
import { ZONES } from './inventory-admin';
import type { User } from './types';

/**
 * Admin control of daily-ticket sales for ONE performance (Admin → Availability).
 * Closing or opening sales flips "On sale" (products.enabled) of that performance's daily
 * tickets only, never another performance's and never a season ticket (Seasons tab). It changes
 * no price, stock, hold or booking: tickets already bought stay valid, and holds placed before a
 * close get no new payment order (assertHeldBookingsSellable) and simply expire.
 */

export interface ZoneSales {
  zone: string;
  productId: string | null;
  price: number | null;
  enabled: boolean | null;
  ceiling: number;
  allocation: number | null;
  held: number;
  sold: number;
  remaining: number;
  state: ZoneAvailability;
  reason: string;
}
export interface PerformanceSales {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  salesClosesAt: string | null;
  state: PerformanceAvailability;
  zones: ZoneSales[];
}

/** Why customer sales are off for every performance, or null when they are open. */
function salesBlockedReason(): string | null {
  if (configurationProblems().length > 0) return 'Sales settings are incomplete (see Ops → configuration).';
  if (!publicSalesOpen()) return 'Public sales are off (server setting ALLOW_PUBLIC_SALES).';
  return null;
}

type Row = {
  show_id: string; title: string; starts_at: Date; ends_at: Date; status: string; sales_closes_at: Date | null;
  festival_status: string; booking_opens_at: Date | null; zone: string; ceiling: number;
  allocation: number | null; held: number | null; committed: number | null;
  product_id: string | null; price: number | null; enabled: boolean | null; cap: number | null; cap_used: number;
};

export async function performanceSalesOverview(nowMs = Date.now()): Promise<PerformanceSales[]> {
  const rows = await query<Row>(`SELECT s.id show_id, s.title, s.starts_at, s.ends_at, s.status, s.sales_closes_at,
      f.status festival_status, f.booking_opens_at, cap.zone, cap.ceiling,
      d.allocation, d.held, d.committed, dp.id product_id, dp.price, dp.enabled, dp.cap,
      (SELECT COALESCE(sum(quantity),0)::int FROM bookings b WHERE b.product_id=dp.id AND b.status IN ('HELD','PAYMENT_PENDING','CONFIRMED')) cap_used
    FROM shows s JOIN festivals f ON f.id=s.festival_id
    JOIN capacities cap ON cap.show_id=s.id
    LEFT JOIN pools d ON d.capacity_id=cap.id AND d.kind='DAILY'
    LEFT JOIN products dp ON dp.show_id=s.id AND dp.kind='DAILY' AND dp.category=cap.zone
    ORDER BY s.starts_at, s.id, array_position(ARRAY['Premier','Superior','Balcony'], cap.zone)`);
  const blocked = salesBlockedReason();
  const shows = new Map<string, PerformanceSales & { bookingOpensAt: Date | null }>();
  for (const r of rows) {
    const show = shows.get(r.show_id) ?? {
      id: r.show_id, title: r.title, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
      status: r.status, salesClosesAt: r.sales_closes_at ? new Date(r.sales_closes_at).toISOString() : null,
      state: 'SALES_CLOSED' as PerformanceAvailability, zones: [], bookingOpensAt: r.booking_opens_at,
    };
    const held = Number(r.held ?? 0), committed = Number(r.committed ?? 0);
    const { state, reason, remaining } = zoneAvailability({
      showStatus: r.status, festivalStatus: r.festival_status, startsAt: r.starts_at, salesClosesAt: r.sales_closes_at,
      bookingOpensAt: r.booking_opens_at, productId: r.product_id, enabled: r.enabled,
      allocation: r.allocation === null ? null : Number(r.allocation), held, committed,
      cap: r.cap === null ? null : Number(r.cap), capUsed: Number(r.cap_used), salesBlocked: blocked,
    }, nowMs);
    show.zones.push({
      zone: r.zone, productId: r.product_id, price: r.price === null ? null : Number(r.price), enabled: r.enabled,
      ceiling: Number(r.ceiling), allocation: r.allocation === null ? null : Number(r.allocation), held, sold: committed, remaining, state, reason,
    });
    shows.set(r.show_id, show);
  }
  return [...shows.values()].map(({ bookingOpensAt, ...show }) => ({
    ...show,
    state: performanceAvailability({ status: show.status, ends_at: show.endsAt }, show.zones.map((z) => z.state), bookingOpensAt, nowMs),
  }));
}

/**
 * Opens or closes daily-ticket sales for one performance, or for one zone of it.
 * A cancelled performance cannot be reopened. Audited with the products changed.
 */
export async function setPerformanceSales(user: User, showId: string, input: { open?: unknown; zone?: unknown }) {
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(showId), 'Performance not found.', 404);
  requireValue(typeof input.open === 'boolean', 'Say whether to open or close sales.', 400);
  const open = input.open as boolean;
  const zone = input.zone === undefined || input.zone === null || input.zone === '' ? null : String(input.zone);
  requireValue(zone === null || (ZONES as readonly string[]).includes(zone), 'Unknown zone.', 400);
  return transaction(async (c) => {
    const show = await one<{ id: string; status: string; title: string }>(c, 'SELECT id, status, title FROM shows WHERE id=$1 FOR UPDATE', [showId]);
    requireValue(show, 'Performance not found.', 404);
    requireValue(!(open && show.status === 'CANCELLED'), 'This performance was cancelled. Cancellation is final; it cannot be put on sale again.', 409);
    const products = (await c.query<{ id: string; category: string; enabled: boolean }>(
      `SELECT id, category, enabled FROM products WHERE show_id=$1 AND kind='DAILY' AND ($2::text IS NULL OR category=$2) ORDER BY id FOR UPDATE`,
      [showId, zone])).rows;
    requireValue(products.length > 0, zone ? `This performance has no daily ticket for ${zone}.` : 'This performance has no daily tickets.', 404);
    const changed = products.filter((p) => p.enabled !== open);
    if (changed.length > 0) {
      await c.query('UPDATE products SET enabled=$1 WHERE id=ANY($2::uuid[])', [open, changed.map((p) => p.id)]);
    }
    await audit(c, user.id, open ? 'show.sales.open' : 'show.sales.close', showId, {
      zone, products: changed.map((p) => ({ id: p.id, zone: p.category, before: p.enabled, after: open })),
    });
    return { ok: true, open, zone, changed: changed.length };
  }, true);
}
