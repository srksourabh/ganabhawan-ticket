import { verifyOtp } from '@/lib/auth';
import { jsonOk, jsonError, readJson, setSessionCookie } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson<{ challengeId?: string; code?: string; mfaCode?: string }>(request);
    const result = await verifyOtp(
      body.challengeId ?? '',
      body.code ?? '',
      body.mfaCode ?? '',
    );
    const response = jsonOk({ user: result.user });
    return setSessionCookie(response, result.sessionToken!);
  } catch (error) {
    return jsonError(error);
  }
}
