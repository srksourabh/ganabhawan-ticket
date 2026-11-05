import { authenticated } from '@/lib/auth';
import { ADMIN_POLICY } from '@/lib/admin-policy';
import { setProgrammeInclusion } from '@/lib/programme-inclusion';
import { jsonOk, jsonError, readJson } from '@/lib/http';

/** Includes or excludes a programme in All Together — Every Play: { include: boolean }. New purchases only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await authenticated(ADMIN_POLICY.catalogue);
    const { id } = await params;
    const body = await readJson<{ include?: unknown }>(request);
    return jsonOk(await setProgrammeInclusion(user, id, body.include));
  } catch (error) {
    return jsonError(error);
  }
}
