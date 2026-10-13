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

/** Every performance the product covers must be PUBLISHED and not yet started. */
export function salesOpen(coverage: Pick<CoveredPerformance, 'status' | 'starts_at'>[], nowMs = Date.now()) {
  return coverage.length > 0 && coverage.every((s) => s.status === 'PUBLISHED' && new Date(s.starts_at).getTime() > nowMs);
}

/**
 * The admin's season-ticket switch (festivals.season_sales_open, migration 0010) applies to
 * NEW season sales only, on top of every other rule (global sales switch, product "On sale",
 * sales window, stock). Anything but an explicit true (unset, or the column not migrated
 * yet) counts as closed. Daily tickets never depend on it.
 */
export function seasonSaleBlocked(kind: string, seasonSalesOpen: unknown) {
  return kind === 'SEASON' && seasonSalesOpen !== true;
}

/**
 * SQL for a festivals row aliased `f`: true only when the switch is on. Read through to_jsonb
 * so a database without migration 0010 yields false (season closed) instead of failing
 * every daily-ticket query that joins festivals.
 */
export const SEASON_SALES_OPEN_SQL = "((to_jsonb(f)->>'season_sales_open') IS NOT DISTINCT FROM 'true')";

/** Tickets that can still be held: the scarcest covered pool, bounded by the product cap. */
export function remainingTickets(coverage: CoveredPerformance[], cap: number | null, capUsed: number) {
  if (coverage.length === 0) return 0;
  const pools = Math.min(...coverage.map((p) => Number(p.allocation) - Number(p.held) - Number(p.committed)));
  const byCap = cap === null || cap === undefined ? Number.POSITIVE_INFINITY : Number(cap) - capUsed;
  return Math.max(0, Math.min(pools, byCap));
}

export function sellState(coverage: CoveredPerformance[], cap: number | null, capUsed: number, nowMs = Date.now()) {
  if (!salesOpen(coverage, nowMs)) return { state: 'CLOSED' as SellState, available: 0 };
  const available = remainingTickets(coverage, cap, capUsed);
  return { state: (available > 0 ? 'SELLABLE' : 'SOLD_OUT') as SellState, available };
}
