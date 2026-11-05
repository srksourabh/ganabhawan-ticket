/**
 * The status tag on a "Choose a performance" card, derived ONLY from what the server already
 * decided for that performance's daily tickets (catalogue.ts publicProducts → availability.ts):
 * each zone's state (SELLABLE / SOLD_OUT / CLOSED), its seats still available and its online
 * daily allocation. No separate availability system; the booking details below the cards show
 * the same figures, so the card and the zone list never disagree. Pure: safe in the browser.
 */
export type PerformanceStatus = 'AVAILABLE' | 'SELLING_FAST' | 'FEW_SEATS' | 'SOLD_OUT' | 'CLOSED';

/** "Few Seats": at most this many seats left across the zones still on sale… */
export const FEW_SEATS_MAX = 10;
/** …or at most this share of the online daily seats left. */
export const FEW_SEATS_SHARE = 0.1;
/** "Selling Fast": at least this share of the online daily seats sold or being bought. */
export const SELLING_FAST_SHARE = 0.6;

export interface ZoneSale {
  state?: 'SELLABLE' | 'SOLD_OUT' | 'CLOSED';
  available: number;
  /** Online daily seats for the zone (pool allocation); absent → only exact states are shown. */
  capacity?: number | null;
}

export function performanceStatus(zones: ZoneSale[], startsAt: string, nowMs = Date.now()): PerformanceStatus {
  // The booking details close daily sales once the performance has started (catalogue page).
  if (zones.length === 0 || new Date(startsAt).getTime() <= nowMs) return 'CLOSED';
  const open = zones.filter((z) => z.state === 'SELLABLE' && z.available > 0);
  if (open.length === 0) return zones.some((z) => z.state === 'SOLD_OUT') ? 'SOLD_OUT' : 'CLOSED';
  const left = open.reduce((n, z) => n + z.available, 0);
  const capacity = open.every((z) => typeof z.capacity === 'number' && z.capacity > 0)
    ? open.reduce((n, z) => n + Number(z.capacity), 0)
    : null;
  if (left <= FEW_SEATS_MAX || (capacity !== null && left <= capacity * FEW_SEATS_SHARE)) return 'FEW_SEATS';
  if (capacity !== null && capacity - left >= capacity * SELLING_FAST_SHARE) return 'SELLING_FAST';
  return 'AVAILABLE';
}

/** Message key of each tag (i18n.ts). */
export const STATUS_KEY = {
  AVAILABLE: 'perf.available', SELLING_FAST: 'perf.sellingFast', FEW_SEATS: 'perf.fewSeats', SOLD_OUT: 'perf.soldOut', CLOSED: 'perf.closed',
} as const;
