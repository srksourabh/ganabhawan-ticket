/**
 * What the auditorium map shows for one zone of the selected performance (AuditoriumMap.tsx).
 * The server decides each product's state (availability.ts productSellState); this only names it:
 *  - UNAVAILABLE: no ticket for this zone is on sale at all (none listed for this performance);
 *  - CLOSED: the server says sales are closed (sales paused, window over, configuration not ready);
 *    NOT "sold out": seats may well remain;
 *  - SOLD_OUT: on sale, but nothing left;
 *  - AVAILABLE: on sale with tickets left. The only state a customer can choose.
 */
export type ZoneStatus = 'AVAILABLE' | 'SOLD_OUT' | 'CLOSED' | 'UNAVAILABLE';

export function zoneStatus(zone: { productId: string | null; available: number; closed?: boolean }): ZoneStatus {
  if (!zone.productId) return 'UNAVAILABLE';
  if (zone.closed) return 'CLOSED';
  if (zone.available <= 0) return 'SOLD_OUT';
  return 'AVAILABLE';
}
