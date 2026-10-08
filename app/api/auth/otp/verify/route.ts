import { verifyOtp } from '@/lib/auth';
import { jsonOk, jsonError, readJson, setSessionCookie } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson<{ challengeId?: string; code?: string }>(request);
    const result = await verifyOtp(body.challengeId ?? '', body.code ?? '');
    const mobile = request.headers.get('x-client') === 'mobile';
    const response = jsonOk(mobile ? { user: result.user, sessionToken: result.sessionToken } : { user: result.user });
    return setSessionCookie(response, result.sessionToken!);
  } catch (error) {
    return jsonError(error);
  }
}
