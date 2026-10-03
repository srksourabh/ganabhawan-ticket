import { accountsLedger } from '@/lib/attempts';
import { authenticated } from '@/lib/auth';
import { AppError } from '@/lib/errors';
import { jsonError, jsonOk } from '@/lib/http';

export async function GET(): Promise<Response> {
  try {
    const user = await authenticated();
    if (user.role !== 'owner' && user.role !== 'finance') throw new AppError(403, 'Only the owner and finance can view the ledger.');
    return jsonOk(await accountsLedger());
  } catch (error) {
    return jsonError(error);
  }
}
