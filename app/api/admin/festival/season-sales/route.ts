import { authenticated } from '@/lib/auth';
import { seasonSalesState, setSeasonSales } from '@/lib/catalogue';
import { jsonOk, jsonError, readJson } from '@/lib/http';

const STAFF_ROLES = ['owner', 'inventory'] as const;

/** The admin's switch for new season-ticket sales: { open, migrated } (catalogue.ts seasonSalesState). */
export async function GET(): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    return jsonOk(await seasonSalesState(user));
  } catch (error) {
    return jsonError(error);
  }
}

/** Body { open: boolean }. Answers with the stored state. */
export async function PUT(request: Request): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    return jsonOk(await setSeasonSales(user, await readJson<Record<string, unknown>>(request)));
  } catch (error) {
    return jsonError(error);
  }
}
