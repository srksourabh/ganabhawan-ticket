import { AppError } from './errors';

const SESSION_COOKIE = 'festival_session';
const MAX_AGE = 12 * 60 * 60; // 12 hours in seconds

export function jsonOk(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function jsonError(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json({ error: error.message, code: error.code, ...(error.productId ? { productId: error.productId } : {}) }, { status: error.status });
  }
  console.error('[unhandled]', error);
  return Response.json({ error: 'An unexpected error occurred.', code: 'INTERNAL_ERROR' }, { status: 500 });
}

export async function readJson<T = unknown>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new AppError(400, 'Invalid JSON body.');
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

function cookieFlags(maxAge: number): string {
  const secure = (process.env.APP_URL ?? '').startsWith('https://') ? '; Secure' : '';
  return `HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function setSessionCookie(response: Response, sessionToken: string): Response {
  response.headers.append('Set-Cookie', `${SESSION_COOKIE}=${sessionToken}; ${cookieFlags(MAX_AGE)}`);
  return response;
}

export function clearSessionCookie(response: Response): Response {
  response.headers.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags(0)}`);
  return response;
}
