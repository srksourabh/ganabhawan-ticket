import { accountsLedger } from '@/lib/attempts';
import { authenticated } from '@/lib/auth';
import { AppError } from '@/lib/errors';
import { jsonError, jsonOk } from '@/lib/http';

export async function GET(): Promise<Response> {
  try {
    const user = await authenticated();
    if (user.role === 'customer') throw new AppError(403, 'Staff sign-in required.');
    return jsonOk(await accountsLedger());
  } catch (error) {
    return jsonError(error);
  }
}
