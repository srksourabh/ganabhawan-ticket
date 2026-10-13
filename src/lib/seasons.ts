import { query, transaction, one } from './db';
import { AppError, requireValue } from './errors';
import { audit } from './audit';
import { ADMIN_POLICY } from './admin-policy';
import { activeCoverage, seasonSaleBlocked, sellState } from './availability';
import { configurationProblems, publicSalesOpen, seasonTicketSalesEnabled } from './env';
import { addShowToSeason, createSeasonProduct } from './inventory-admin';
import type { User } from './types';

/**
 * Season management for the admin dashboard. There is no separate "season" entity in the
 * schema: a season ticket is a products row (kind 'SEASON'), one per zone, covering an
 * explicit list of performances (product_coverage → each performance's SEASON pool).
 * Bookings, tickets, entitlements and payments reference it, so its history is never
 * deleted: a season ticket that was ever booked is switched off ("On sale" off) instead.
 * Whether NEW season sales are open is the runtime setting SEASON_TICKET_SALES_ENABLED
 * (read-only here) together with ALLOW_PUBLIC_SALES and every existing sales rule.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 120;

function assertSeasonRole(user: User) {
  requireValue(user.role === 'owner' || (ADMIN_POLICY.catalogue as readonly string[]).includes(user.role), 'You do not have permission for this action.', 403);
}

type CoverageRow = { show_id: string; title: string; starts_at: string; status: string; allocation: number; held: number; committed: number };
type SeasonRow = {
  id: string; name: string; name_bn: string; category: string; price: number; enabled: boolean; version: number; cap: number | null;
  cap_used: number; confirmed: number; in_progress: number; history: number; coverage: CoverageRow[];
};

/** Why a season ticket cannot be bought right now (empty = customers can buy it), by rule, never a secret value. */
function closedReasons(s: SeasonRow, state: string, sales: { configured: boolean; publicSales: boolean; seasonSwitch: boolean }) {
  const reasons: string[] = [];
  if (!s.enabled) reasons.push('Not on sale ("On sale" is off).');
  if (!sales.seasonSwitch) reasons.push('Season-ticket sales are switched off (SEASON_TICKET_SALES_ENABLED is not "true").');
  if (!sales.publicSales) reasons.push('Public sales are paused (ALLOW_PUBLIC_SALES is not "true").');
  if (!sales.configured) reasons.push('Customer sales are not fully configured (see Operations status).');
  if (activeCoverage(s.coverage).length === 0) reasons.push('It covers no remaining performance.');
  else if (state === 'CLOSED') reasons.push('A covered performance has started or is not published.');
  if (state === 'SOLD_OUT') reasons.push('Sold out.');
  return reasons;
}

/** Every season ticket with its performances, sales state and whether it may be deleted. */
export async function seasonsOverview(user: User, nowMs = Date.now()) {
  assertSeasonRole(user);
  const rows = await query<SeasonRow>(
    `SELECT p.id, p.name, p.name_bn, p.category, p.price, p.enabled, p.version, p.cap,
       (SELECT COALESCE(sum(quantity),0)::int FROM bookings b WHERE b.product_id=p.id AND b.status IN ('HELD','PAYMENT_PENDING','CONFIRMED')) cap_used,
       (SELECT count(*)::int FROM bookings b WHERE b.product_id=p.id AND b.status='CONFIRMED') confirmed,
       (SELECT count(*)::int FROM bookings b WHERE b.product_id=p.id AND b.status IN ('HELD','PAYMENT_PENDING')) in_progress,
       ((SELECT count(*) FROM bookings b WHERE b.product_id=p.id) + (SELECT count(*) FROM booking_attempts a WHERE a.product_id=p.id))::int history,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('show_id',s.id,'title',s.title,'starts_at',s.starts_at,'status',s.status,
         'allocation',i.allocation,'held',i.held,'committed',i.committed) ORDER BY s.starts_at)
         FROM product_coverage pc JOIN shows s ON s.id=pc.show_id JOIN pools i ON i.id=pc.pool_id WHERE pc.product_id=p.id),'[]'::jsonb) coverage
     FROM products p WHERE p.kind='SEASON'
     ORDER BY array_position(ARRAY['Premier','Superior','Balcony'], p.category), p.name`,
  );
  const upcoming = await query<{ id: string; title: string; starts_at: string }>(
    "SELECT id, title, starts_at FROM shows WHERE status='PUBLISHED' AND starts_at>now() ORDER BY starts_at",
  );
  const sales = { configured: configurationProblems().length === 0, publicSales: publicSalesOpen(), seasonSwitch: seasonTicketSalesEnabled() };
  const seasons = rows.map((s) => {
    const { state, available } = sellState(s.coverage, s.cap === null ? null : Number(s.cap), Number(s.cap_used), nowMs);
    const reasons = closedReasons(s, state, sales);
    return {
      id: s.id, name: s.name, nameBn: s.name_bn, zone: s.category, price: Number(s.price), enabled: s.enabled, version: Number(s.version),
      available, state, open: reasons.length === 0, closedReasons: reasons,
      confirmedBookings: Number(s.confirmed), purchasesInProgress: Number(s.in_progress),
      performances: s.coverage.map((c) => ({ id: c.show_id, title: c.title, startsAt: new Date(c.starts_at).toISOString(), status: c.status })),
      // Performances can change only before anything was bought (the same rule as addShowToSeason).
      performancesLocked: Number(s.history) > 0,
      deletable: Number(s.history) === 0,
      deleteBlockedReason: Number(s.history) > 0
        ? 'This season ticket has bookings or purchase attempts, so its history is kept. Turn "On sale" off instead.'
        : null,
    };
  });
  return {
    sales: { ...sales, open: sales.configured && sales.publicSales && sales.seasonSwitch, setting: 'SEASON_TICKET_SALES_ENABLED' as const, seasonBlocked: seasonSaleBlocked('SEASON') },
    zonesWithoutSeason: ['Premier', 'Superior', 'Balcony'].filter((z) => !rows.some((r) => r.category === z)),
    upcomingPerformances: upcoming.map((s) => ({ id: s.id, title: s.title, startsAt: new Date(s.starts_at).toISOString() })),
    seasons,
  };
}

/** Creates a zone's season ticket (inventory-admin createSeasonProduct: one per zone, covers upcoming published performances). */
export async function createSeason(user: User, input: Record<string, unknown>) {
  assertSeasonRole(user);
  const unknown = Object.keys(input ?? {}).filter((k) => !['zone', 'name', 'nameBn', 'price'].includes(k));
  requireValue(unknown.length === 0, `Unknown field(s): ${unknown.join(', ')}.`, 400);
  return createSeasonProduct(user, { category: input.zone, name: input.name, nameBn: input.nameBn, price: input.price });
}

/**
 * Edits a season ticket's name (English, Bengali), price (paise) and "On sale". Only the fields
 * sent change; `version` must match (someone else's edit is never overwritten). Zone, kind and
 * coverage are not editable here.
 */
export async function updateSeason(user: User, id: string, input: Record<string, unknown>) {
  assertSeasonRole(user);
  requireValue(UUID.test(id), 'Season ticket not found.', 404);
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Send the fields to change.', 400);
  const allowed = ['name', 'nameBn', 'price', 'enabled', 'version'];
  const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
  requireValue(unknown.length === 0, `These fields cannot be changed: ${unknown.join(', ')}.`, 400);
  requireValue(Number.isInteger(input.version), 'Refresh the page and try again.', 400);
  const fields: Record<string, string> = {};
  if (input.name !== undefined) {
    requireValue(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.trim().length <= NAME_MAX, `Name is required (at most ${NAME_MAX} characters).`, 400);
  }
  if (input.nameBn !== undefined) {
    requireValue(typeof input.nameBn === 'string' && input.nameBn.trim().length > 0 && input.nameBn.trim().length <= NAME_MAX, `Bengali name is required (at most ${NAME_MAX} characters).`, 400);
  }
  if (input.price !== undefined) requireValue(Number.isInteger(input.price) && (input.price as number) > 0, 'Price must be a positive whole number of paise.', 400);
  if (input.enabled !== undefined) requireValue(typeof input.enabled === 'boolean', '"On sale" must be true or false.', 400);
  return transaction(async (c) => {
    const p = await one<{ id: string; kind: string; name: string; name_bn: string; price: number; enabled: boolean; version: number }>(
      c, 'SELECT * FROM products WHERE id=$1 FOR UPDATE', [id]);
    requireValue(p && p.kind === 'SEASON', 'Season ticket not found.', 404);
    requireValue(Number(p!.version) === input.version, 'This season ticket was changed by someone else. Refresh and try again.', 409);
    const next = {
      name: input.name !== undefined ? (input.name as string).trim() : p!.name,
      name_bn: input.nameBn !== undefined ? (input.nameBn as string).trim() : p!.name_bn,
      price: input.price !== undefined ? (input.price as number) : Number(p!.price),
      enabled: input.enabled !== undefined ? (input.enabled as boolean) : p!.enabled,
    };
    const before = { name: p!.name, nameBn: p!.name_bn, price: Number(p!.price), enabled: p!.enabled };
    const after = { name: next.name, nameBn: next.name_bn, price: next.price, enabled: next.enabled };
    for (const key of Object.keys(after) as (keyof typeof after)[]) if (before[key] !== after[key]) fields[key] = String(after[key]);
    const updated = (await one<{ version: number }>(c,
      'UPDATE products SET name=$1, name_bn=$2, price=$3, enabled=$4, version=version+1 WHERE id=$5 RETURNING version',
      [next.name, next.name_bn, next.price, next.enabled, id]))!;
    await audit(c, user.id, 'product.season.update', id, { before, after });
    return { id, ...after, version: Number(updated.version), changed: Object.keys(fields) };
  }, true);
}

/** Adds a performance (inventory-admin addShowToSeason: upcoming, not cancelled, before any sale). */
export async function addSeasonPerformance(user: User, id: string, showId: unknown) {
  assertSeasonRole(user);
  requireValue(UUID.test(id) && typeof showId === 'string' && UUID.test(showId), 'Choose a performance.', 400);
  return addShowToSeason(user, id, showId as string);
}

/**
 * Removes a performance from a season ticket. Like adding, only before anything was bought
 * (no booking or purchase attempt, any status), so what customers bought never changes, and
 * never the last performance (delete the season ticket instead).
 */
export async function removeSeasonPerformance(user: User, id: string, showId: string) {
  assertSeasonRole(user);
  requireValue(UUID.test(id) && UUID.test(showId), 'Performance not found.', 404);
  return transaction(async (c) => {
    const p = await one<{ id: string; kind: string }>(c, 'SELECT id, kind FROM products WHERE id=$1 FOR UPDATE', [id]);
    requireValue(p && p.kind === 'SEASON', 'Season ticket not found.', 404);
    const history = await one<{ n: number }>(c,
      'SELECT ((SELECT count(*) FROM bookings WHERE product_id=$1) + (SELECT count(*) FROM booking_attempts WHERE product_id=$1))::int n', [id]);
    requireValue(Number(history?.n ?? 0) === 0, 'This season ticket has already been booked; its performances can no longer change.', 409);
    const covered = await one<{ n: number; included: boolean }>(c,
      'SELECT count(*)::int n, bool_or(show_id=$2) included FROM product_coverage WHERE product_id=$1', [id, showId]);
    requireValue(covered?.included === true, 'This performance is not part of the season ticket.', 404);
    requireValue(Number(covered!.n) > 1, 'A season ticket needs at least one performance. Delete the season ticket instead.', 409);
    await c.query('DELETE FROM product_coverage WHERE product_id=$1 AND show_id=$2', [id, showId]);
    await c.query('UPDATE products SET version=version+1 WHERE id=$1', [id]);
    await audit(c, user.id, 'product.season.remove_show', id, { showId });
    return { productId: id, showId };
  }, true);
}

/**
 * Deletes a season ticket only if it was never booked or attempted (bookings and
 * booking_attempts reference it and are financial/ticketing history). Otherwise 409 with the
 * reason; turning "On sale" off is the supported way to retire it. Unpaid account-cart lines
 * for it are removed with it (cart_items cascade).
 */
export async function deleteSeason(user: User, id: string) {
  assertSeasonRole(user);
  requireValue(UUID.test(id), 'Season ticket not found.', 404);
  return transaction(async (c) => {
    const p = await one<{ id: string; kind: string; name: string; category: string; price: number }>(c, 'SELECT * FROM products WHERE id=$1 FOR UPDATE', [id]);
    requireValue(p && p.kind === 'SEASON', 'Season ticket not found.', 404);
    const history = await one<{ bookings: number; attempts: number }>(c,
      'SELECT (SELECT count(*) FROM bookings WHERE product_id=$1)::int bookings, (SELECT count(*) FROM booking_attempts WHERE product_id=$1)::int attempts', [id]);
    if (Number(history?.bookings ?? 0) + Number(history?.attempts ?? 0) > 0) {
      throw new AppError(409, `"${p!.name}" has ${history!.bookings} booking(s) and ${history!.attempts} purchase attempt(s), so its history is kept. Turn "On sale" off instead.`, 'SEASON_HAS_HISTORY');
    }
    await c.query('DELETE FROM product_coverage WHERE product_id=$1', [id]);
    await c.query('DELETE FROM products WHERE id=$1', [id]);
    await audit(c, user.id, 'product.season.delete', id, { name: p!.name, zone: p!.category, price: Number(p!.price) });
    return { deleted: id };
  }, true);
}
