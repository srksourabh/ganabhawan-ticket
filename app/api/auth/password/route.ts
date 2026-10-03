import { loginWithPassword } from '@/lib/auth';
import { clientIp, jsonOk, jsonError, readJson, setSessionCookie } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson<{ email?: string; username?: string; password?: string; mfaCode?: string }>(request);
    const identifier = body.email || body.username || '';
    const result = await loginWithPassword(identifier, body.password ?? '', body.mfaCode ?? '', clientIp(request));
    const mobile = request.headers.get('x-client') === 'mobile';
    const response = jsonOk(mobile ? { user: result.user, sessionToken: result.sessionToken } : { user: result.user });
    return setSessionCookie(response, result.sessionToken!);
  } catch (error) {
    return jsonError(error);
  }
}
