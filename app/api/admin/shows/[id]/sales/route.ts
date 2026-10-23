import { authenticated } from '@/lib/auth';
import { setPerformanceSales } from '@/lib/performance-sales';
import { jsonOk, jsonError, readJson } from '@/lib/http';
import { ADMIN_POLICY } from '@/lib/admin-policy';

/** Open or close daily-ticket sales for one performance: { open: boolean, zone?: 'Premier' | 'Superior' | 'Balcony' }. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await authenticated([...ADMIN_POLICY.catalogue]);
    const { id } = await params;
    return jsonOk(await setPerformanceSales(user, id, await readJson<Record<string, unknown>>(request)));
  } catch (error) {
    return jsonError(error);
  }
}
