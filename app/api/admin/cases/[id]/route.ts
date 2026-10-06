import { authenticated } from '@/lib/auth';
import { transaction, one } from '@/lib/db';
import { audit } from '@/lib/audit';
import { AppError } from '@/lib/errors';
import { jsonError, jsonOk, readJson } from '@/lib/http';

/** Owner/finance closes a reconciliation case after handling it, with a recorded note. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await authenticated(['finance']);
    const { id } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError(404, 'Open case not found.');
    const body = await readJson<{ note?: string }>(request);
    const note = (body.note ?? '').trim().slice(0, 500);
    if (note.length < 5) throw new AppError(400, 'Describe how the case was resolved (at least 5 characters).');
    const result = await transaction(async (c) => {
      const row = await one<{ id: string }>(c, "UPDATE reconciliation_cases SET state='RESOLVED' WHERE id=$1::uuid AND state='OPEN' RETURNING id", [id]);
      if (!row) throw new AppError(404, 'Open case not found.');
      await audit(c, user.id, 'case.resolve', id, { note });
      return row;
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
