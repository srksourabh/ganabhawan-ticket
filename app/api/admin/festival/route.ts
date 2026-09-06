import { authenticated } from '@/lib/auth';
import { adminCatalogue, updateFestival } from '@/lib/catalogue';
import { jsonOk, jsonError, readJson } from '@/lib/http';

const STAFF_ROLES = ['owner', 'inventory'] as const;

export async function GET(): Promise<Response> {
  try {
    await authenticated([...STAFF_ROLES]);
    const { festival } = await adminCatalogue();
    return jsonOk({ festival });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    const body = await readJson<Record<string, unknown>>(request);
    const result = await updateFestival(user, body);
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
