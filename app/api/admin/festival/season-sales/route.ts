import { authenticated } from '@/lib/auth';
import { seasonSalesState } from '@/lib/catalogue';
import { jsonOk, jsonError } from '@/lib/http';

const STAFF_ROLES = ['owner', 'inventory'] as const;

/**
 * Whether NEW season-ticket sales are open: { open, setting } (catalogue.ts seasonSalesState).
 * Read-only: the switch is the runtime setting SEASON_TICKET_SALES_ENABLED, not a database value.
 */
export async function GET(): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    return jsonOk(seasonSalesState(user));
  } catch (error) {
    return jsonError(error);
  }
}
