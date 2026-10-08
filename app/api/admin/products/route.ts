import { authenticated } from '@/lib/auth';
import { adminCatalogue } from '@/lib/catalogue';
import { createSeasonProduct } from '@/lib/inventory-admin';
import { jsonOk, jsonError, readJson } from '@/lib/http';

const STAFF_ROLES = ['owner', 'inventory'] as const;

export async function GET(): Promise<Response> {
  try {
    await authenticated([...STAFF_ROLES]);
    const { products } = await adminCatalogue();
    return jsonOk({ products });
  } catch (error) {
    return jsonError(error);
  }
}

/** Creates the season ticket for a zone: { category, name, nameBn, price (paise) }. */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    return jsonOk(await createSeasonProduct(user, await readJson<Record<string, unknown>>(request)), 201);
  } catch (error) {
    return jsonError(error);
  }
}
