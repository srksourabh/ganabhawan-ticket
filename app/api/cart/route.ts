import { authenticated } from '@/lib/auth';
import { readAccountCart, saveAccountCart } from '@/lib/account-cart';
import { jsonError, jsonOk, readJson } from '@/lib/http';

/** The signed-in customer's own cart (server-stored, live prices and availability). Guests keep theirs in the browser. */
export async function GET(): Promise<Response> {
  try {
    const user = await authenticated();
    return jsonOk({ lines: await readAccountCart(user.id), notices: [] });
  } catch (error) {
    return jsonError(error);
  }
}

/** Replaces the cart with { lines: [{ productId, quantity }] }. Selections only: nothing is held. */
export async function PUT(request: Request): Promise<Response> {
  try {
    const user = await authenticated();
    const body = await readJson<{ lines?: unknown }>(request);
    return jsonOk(await saveAccountCart(user.id, body.lines ?? []));
  } catch (error) {
    return jsonError(error);
  }
}
