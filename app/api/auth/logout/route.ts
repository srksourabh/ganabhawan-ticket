import { cookies, headers } from 'next/headers';
import { query } from '@/lib/db';
import { clearSessionCookie, jsonError, jsonOk } from '@/lib/http';
import { hash } from '@/lib/security';

export async function POST(): Promise<Response> {
  try {
    const authorization = (await headers()).get('authorization') ?? '';
    const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
    const value = bearer || (await cookies()).get('festival_session')?.value;
    if (value) {
      await query('DELETE FROM sessions WHERE digest=$1', [hash(value)]);
    }
    return clearSessionCookie(jsonOk({ ok: true }));
  } catch (error) {
    return jsonError(error);
  }
}
