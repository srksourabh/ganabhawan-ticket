import { jsonOk, jsonError, clearSessionCookie } from '@/lib/http';

export async function POST(): Promise<Response> {
  try {
    const response = jsonOk({ ok: true });
    return clearSessionCookie(response);
  } catch (error) {
    return jsonError(error);
  }
}
