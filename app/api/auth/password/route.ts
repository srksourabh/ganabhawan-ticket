import { loginWithPassword } from '@/lib/auth';
import { jsonOk, jsonError, readJson, setSessionCookie } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson<{ email?: string; username?: string; password?: string }>(request);
    const identifier = body.email || body.username || '';
    const result = await loginWithPassword(identifier, body.password ?? '');
    const response = jsonOk({ user: result.user, sessionToken: result.sessionToken });
    return setSessionCookie(response, result.sessionToken!);
  } catch (error) {
    return jsonError(error);
  }
}
