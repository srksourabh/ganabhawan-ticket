import { query } from '@/lib/db';
import { jsonOk, jsonError } from '@/lib/http';

export async function GET(): Promise<Response> {
  try {
    let db = false;
    try {
      await query('SELECT 1');
      db = true;
    } catch {
      db = false;
    }
    if (!db) return jsonOk({ ok: false, db: false }, 503);
    return jsonOk({ ok: true, db: true });
  } catch (error) {
    return jsonError(error);
  }
}
