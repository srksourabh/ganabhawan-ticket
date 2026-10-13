import { customerPurchasesOpen, seasonTicketSalesEnabled } from './env';

/**
 * The one definition of "can this product be sold right now", used by both the
 * hold (placeHold, authoritative, under the commerce lock) and the public
 * catalogue (display). They used to disagree: the catalogue ignored covered
 * performances that had ended or were not published, so a season pass looked
 * open while every hold for it failed with "Sales for this performance have closed."
 */
export type SellState = 'SELLABLE' | 'SOLD_OUT' | 'CLOSED';

export interface CoveredPerformance {
  status: string;
  starts_at: string | Date;
  allocation: number | string;
  held: number | string;
  committed: number | string;
}

/**
 * The performances a NEW sale covers: every covered performance except cancelled ones. A
 * cancelled performance can never be attended or admitted, and a booking covering one could
 * never be confirmed (commerce.ts assessBooking), so it must not keep a season ticket closed
 * for the performances that remain. Holds, snapshots and tickets use this same list (placeHold).
 */
export function activeCoverage<T extends Pick<CoveredPerformance, 'status'>>(coverage: T[]): T[] {
  return coverage.filter((s) => s.status !== 'CANCELLED');
}

/**
 * Every remaining (not cancelled) covered performance must be PUBLISHED and not yet started,
 * and at least one must remain. A draft or already-started performance still closes sales.
 */
export function salesOpen(coverage: Pick<CoveredPerformance, 'status' | 'starts_at'>[], nowMs = Date.now()) {
  const active = activeCoverage(coverage);
  return active.length > 0 && active.every((s) => s.status === 'PUBLISHED' && new Date(s.starts_at).getTime() > nowMs);
}

/**
 * The operator's season-ticket switch (SEASON_TICKET_SALES_ENABLED, env.ts) applies to NEW
 * season sales only, on top of every other rule (global sales switch, product "On sale",
 * sales window, stock). Closed unless explicitly enabled. Daily tickets never depend on it.
 */
export function seasonSaleBlocked(kind: string, seasonSalesOpen = seasonTicketSalesEnabled()) {
  return kind === 'SEASON' && seasonSalesOpen !== true;
}

/** Tickets that can still be held: the scarcest covered pool, bounded by the product cap. */
export function remainingTickets(coverage: CoveredPerformance[], cap: number | null, capUsed: number) {
  const active = activeCoverage(coverage);
  if (active.length === 0) return 0;
  const pools = Math.min(...active.map((p) => Number(p.allocation) - Number(p.held) - Number(p.committed)));
  const byCap = cap === null || cap === undefined ? Number.POSITIVE_INFINITY : Number(cap) - capUsed;
  return Math.max(0, Math.min(pools, byCap));
}

/**
 * What customers see for a product (public catalogue, account cart, admin): the same gates a
 * purchase checks, in one place. Closed while customer sales are not open (settings incomplete
 * or ALLOW_PUBLIC_SALES off), for a season ticket while SEASON_TICKET_SALES_ENABLED is off, and
 * otherwise by the sale window and stock (sellState). A purchase re-checks all of it on the server.
 */
export function productSellState(kind: string, coverage: CoveredPerformance[], cap: number | null, capUsed: number, nowMs = Date.now(), salesAllowed = customerPurchasesOpen()) {
  if (!salesAllowed || seasonSaleBlocked(kind)) return { state: 'CLOSED' as SellState, available: 0 };
  return sellState(coverage, cap, capUsed, nowMs);
}

export function sellState(coverage: CoveredPerformance[], cap: number | null, capUsed: number, nowMs = Date.now()) {
  if (!salesOpen(coverage, nowMs)) return { state: 'CLOSED' as SellState, available: 0 };
  const available = remainingTickets(coverage, cap, capUsed);
  return { state: (available > 0 ? 'SELLABLE' : 'SOLD_OUT') as SellState, available };
}
