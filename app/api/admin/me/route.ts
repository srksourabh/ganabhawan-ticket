import { currentUser } from '@/lib/auth';
import { jsonOk, jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';

export async function GET(): Promise<Response> {
  try {
    const user = await currentUser();
    if (!user) throw new AppError(401, 'Please sign in to continue.');
    return jsonOk({ id: user.id, contact: user.contact, name: user.name, role: user.role });
  } catch (error) {
    return jsonError(error);
  }
}
