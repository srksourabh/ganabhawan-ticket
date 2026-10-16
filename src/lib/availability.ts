import { customerPurchasesOpen, seasonTicketSalesEnabled } from './env';

/**
 * The one definition of "can this product be sold right now", used by both the
 * hold (placeHold, authoritative, under the commerce lock) and the public
 * catalogue (display).
 *
 * A season pass closes at the festival's season close (default 19 December 2026,
 * 7pm IST), as soon as any remaining covered night has started, and while the
 * operator's season switch is off.
 * A daily ticket stays on sale past curtain until that show's sales close
 * (default 7pm IST on the production day).
 * Cancelled performances are left out of a new sale.
 */
export type SellState = 'SELLABLE' | 'SOLD_OUT' | 'CLOSED';

export interface CoveredPerformance {
  status: string;
  starts_at: string | Date;
  allocation: number | string;
  held: number | string;
  committed: number | string;
  sales_closes_at?: string | Date | null;
}

/** First production evening: season passes stop at 7pm IST on 19 December 2026 unless the admin sets another time. */
export const DEFAULT_SEASON_CLOSE = '2026-12-19T19:00:00+05:30';

export interface SaleWindow {
  kind?: 'DAILY' | 'SEASON';
  opensAt?: string | Date | null;
  closesAt?: string | Date | null;
}

/** 7pm IST on the calendar day of a performance. */
export function defaultDailyClose(startsAt: string | Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(startsAt));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '01';
  return new Date(`${get('year')}-${get('month')}-${get('day')}T19:00:00+05:30`);
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
 * Open only while every remaining performance is PUBLISHED, the booking window
 * has opened, and the product's close time has not passed.
 */
export function salesOpen(coverage: CoveredPerformance[], nowMs = Date.now(), window: SaleWindow = {}) {
  const active = activeCoverage(coverage);
  if (active.length === 0 || !active.every((show) => show.status === 'PUBLISHED')) return false;
  if (window.opensAt && new Date(window.opensAt).getTime() > nowMs) return false;
  const kind = window.kind ?? (active.length > 1 ? 'SEASON' : 'DAILY');
  if (kind === 'SEASON') {
    if (active.some((show) => new Date(show.starts_at).getTime() <= nowMs)) return false;
    const close = window.closesAt ? new Date(window.closesAt).getTime() : Date.parse(DEFAULT_SEASON_CLOSE);
    return nowMs < close;
  }
  const close = window.closesAt
    ? new Date(window.closesAt).getTime()
    : Math.min(...active.map((show) => {
        const explicit = show.sales_closes_at ? new Date(show.sales_closes_at).getTime() : Number.NaN;
        return Number.isFinite(explicit) ? explicit : defaultDailyClose(show.starts_at).getTime();
      }));
  return nowMs < close;
}

/**
 * The operator's season-ticket switch (SEASON_TICKET_SALES_ENABLED, env.ts) applies to NEW
 * season sales only, on top of every other rule (global sales switch, product "On sale",
 * sales window, stock). Closed unless explicitly enabled. Daily tickets never depend on it.
 */
export function seasonSaleBlocked(kind: string, seasonSalesOpen = seasonTicketSalesEnabled()) {
  return kind === 'SEASON' && seasonSalesOpen !== true;
}

/** Tickets that can still be held: the scarcest remaining pool, bounded by the product cap. */
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
export function productSellState(
  kind: string,
  coverage: CoveredPerformance[],
  cap: number | null,
  capUsed: number,
  nowMs = Date.now(),
  salesAllowed = customerPurchasesOpen(),
  window: SaleWindow = {},
) {
  if (!salesAllowed || seasonSaleBlocked(kind)) return { state: 'CLOSED' as SellState, available: 0 };
  return sellState(coverage, cap, capUsed, nowMs, { ...window, kind: kind === 'SEASON' ? 'SEASON' : 'DAILY' });
}

export function sellState(coverage: CoveredPerformance[], cap: number | null, capUsed: number, nowMs = Date.now(), window: SaleWindow = {}) {
  if (!salesOpen(coverage, nowMs, window)) return { state: 'CLOSED' as SellState, available: 0 };
  const available = remainingTickets(coverage, cap, capUsed);
  return { state: (available > 0 ? 'SELLABLE' : 'SOLD_OUT') as SellState, available };
}
