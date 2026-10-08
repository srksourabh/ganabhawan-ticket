import { authenticated } from '@/lib/auth';
import { mergeGuestCart } from '@/lib/account-cart';
import { jsonError, jsonOk, readJson } from '@/lib/http';

/** After sign-in: { guestCartId, lines } joins the account cart once per guest cart (idempotent). */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated();
    const body = await readJson<{ guestCartId?: string; lines?: unknown }>(request);
    return jsonOk(await mergeGuestCart(user.id, body.guestCartId, body.lines ?? []));
  } catch (error) {
    return jsonError(error);
  }
}
