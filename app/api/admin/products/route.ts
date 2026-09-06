import { authenticated } from '@/lib/auth';
import { adminCatalogue } from '@/lib/catalogue';
import { jsonOk, jsonError } from '@/lib/http';

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
