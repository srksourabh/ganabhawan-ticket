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
