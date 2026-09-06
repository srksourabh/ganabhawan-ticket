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
    return jsonOk({ ok: true, db });
  } catch (error) {
    return jsonError(error);
  }
}
