import { query, transaction, one, type Client } from './db';
import { requireValue } from './errors';
import { sellState, type SellState } from './availability';

/**
 * The signed-in customer's unpaid cart, stored on the server (cart_items), never
 * in the browser: it survives sign-out and session expiry, and another person on
 * the same device cannot see it. It holds selections only: no inventory hold,
 * booking or payment is created here (holds still happen only at checkout, which
 * re-checks everything). Prices, versions and availability are read live.
 *
 * A line is removed for good when it can never be bought again: every performance
 * it covers has ended or been cancelled (a daily ticket: its show; a season ticket:
 * its LAST covered show). Until then it stays, marked with its current sale state.
 */
export const MAX_CART_TICKETS = 6; // same limit as the browser cart
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CartLineState = SellState | 'UNAVAILABLE';
export interface AccountCartLine {
  productId: string; quantity: number; name: string; nameBn: string; category: string; kind: string;
  unitPrice: number; version: number; showTitle: string; showTitleBn: string; startsAt: string;
  state: CartLineState; available: number;
}
export interface CartNotice { productId: string; reason: 'UNAVAILABLE' | 'CLOSED' | 'SOLD_OUT' | 'REDUCED' | 'LIMIT' }

/** SQL predicate (alias ci) for a line that can never be bought again. */
const EXPIRED = `NOT EXISTS (SELECT 1 FROM product_coverage pc JOIN shows s ON s.id=pc.show_id
  WHERE pc.product_id=ci.product_id AND s.status<>'CANCELLED' AND s.ends_at>now())`;

/** Scheduler cleanup (jobs.ts) for every account; reading a cart applies the same rule. Never touches bookings. */
export async function pruneExpiredCartLines() {
  return (await query(`DELETE FROM cart_items ci WHERE ${EXPIRED} RETURNING user_id`)).length;
}

type ProductRow = {
  id: string; name: string; name_bn: string; category: string; kind: string; price: number; version: number; enabled: boolean;
  cap: number | null; cap_used: number; max_quantity: number; festival_status: string;
  coverage: { status: string; starts_at: string; ends_at: string; title: string; title_bn: string; allocation: number; held: number; committed: number }[];
};

async function loadProducts(db: { query: Client['query'] }, ids: string[]) {
  if (ids.length === 0) return new Map<string, ProductRow>();
  const rows = (await db.query<ProductRow>(
    `SELECT p.id, p.name, p.name_bn, p.category, p.kind, p.price, p.version, p.enabled, p.cap, f.max_quantity, f.status festival_status,
       (SELECT COALESCE(sum(quantity),0)::int FROM bookings b WHERE b.product_id=p.id AND b.status IN ('HELD','PAYMENT_PENDING','CONFIRMED')) cap_used,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('status',s.status,'starts_at',s.starts_at,'ends_at',s.ends_at,'title',s.title,'title_bn',s.title_bn,
         'allocation',i.allocation,'held',i.held,'committed',i.committed) ORDER BY s.starts_at)
         FROM product_coverage pc JOIN shows s ON s.id=pc.show_id JOIN pools i ON i.id=pc.pool_id WHERE pc.product_id=p.id),'[]'::jsonb) coverage
     FROM products p JOIN festivals f ON f.id=p.festival_id WHERE p.id = ANY($1::uuid[])`,
    [ids],
  )).rows;
  return new Map(rows.map((r) => [r.id, r]));
}

/** Live state of one product for a cart line (same rule as the catalogue and checkout). */
function lineState(p: ProductRow | undefined, nowMs = Date.now()): { state: CartLineState; available: number; expired: boolean } {
  if (!p) return { state: 'UNAVAILABLE', available: 0, expired: true };
  const expired = !p.coverage.some((s) => s.status !== 'CANCELLED' && new Date(s.ends_at).getTime() > nowMs);
  if (!p.enabled || p.festival_status !== 'PUBLISHED') return { state: 'UNAVAILABLE', available: 0, expired };
  const { state, available } = sellState(p.coverage, p.cap === null ? null : Number(p.cap), Number(p.cap_used), nowMs);
  return { state, available, expired };
}

function toLine(productId: string, quantity: number, p: ProductRow, s: { state: CartLineState; available: number }, nowMs = Date.now()): AccountCartLine {
  // The performance shown: the next one still to start (the last one if all started).
  const next = p.coverage.find((c) => c.status !== 'CANCELLED' && new Date(c.starts_at).getTime() > nowMs) ?? p.coverage.at(-1);
  return {
    productId, quantity, name: p.name, nameBn: p.name_bn, category: p.category, kind: p.kind,
    unitPrice: Number(p.price), version: Number(p.version),
    showTitle: p.kind === 'SEASON' ? '' : next?.title ?? '', showTitleBn: p.kind === 'SEASON' ? '' : next?.title_bn ?? '',
    startsAt: next ? new Date(next.starts_at).toISOString() : '', state: s.state, available: s.available,
  };
}

async function lockCart(c: Client, userId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['cart:' + userId]);
}

async function readIn(c: Client, userId: string) {
  await c.query(`DELETE FROM cart_items ci WHERE ci.user_id=$1 AND ${EXPIRED}`, [userId]);
  const items = (await c.query<{ product_id: string; quantity: number }>('SELECT product_id, quantity FROM cart_items WHERE user_id=$1 ORDER BY updated_at, product_id', [userId])).rows;
  const products = await loadProducts(c, items.map((i) => i.product_id));
  return items.flatMap((i) => {
    const p = products.get(i.product_id);
    return p ? [toLine(i.product_id, Number(i.quantity), p, lineState(p))] : [];
  });
}

export async function readAccountCart(userId: string) {
  return transaction(async (c) => { await lockCart(c, userId); return readIn(c, userId); });
}

type IncomingLine = { productId?: unknown; quantity?: unknown };

function parseLines(raw: unknown): { productId: string; quantity: number }[] {
  requireValue(Array.isArray(raw), 'Send the cart lines.', 400);
  const lines = (raw as IncomingLine[]).slice(0, 20).map((l) => ({ productId: String(l?.productId ?? ''), quantity: Number(l?.quantity) }));
  for (const l of lines) {
    requireValue(UUID.test(l.productId), 'Unknown ticket in cart.', 400);
    requireValue(Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= MAX_CART_TICKETS, 'Choose a valid ticket quantity.', 400);
  }
  requireValue(new Set(lines.map((l) => l.productId)).size === lines.length, 'Each ticket type can appear only once in the cart.', 400);
  return lines;
}

/**
 * Replaces the account cart with what the signed-in customer's browser shows (add,
 * change quantity, remove). Lines for products that no longer exist or can never be
 * bought again are dropped; limits are enforced. Nothing is held.
 */
export async function saveAccountCart(userId: string, raw: unknown) {
  const lines = parseLines(raw);
  requireValue(lines.reduce((n, l) => n + l.quantity, 0) <= MAX_CART_TICKETS, `A cart can hold at most ${MAX_CART_TICKETS} tickets.`, 400);
  return transaction(async (c) => {
    await lockCart(c, userId);
    const products = await loadProducts(c, lines.map((l) => l.productId));
    const notices: CartNotice[] = [];
    const keep = lines.filter((l) => { const p = products.get(l.productId); return p && !lineState(p).expired; });
    await c.query('DELETE FROM cart_items WHERE user_id=$1 AND NOT (product_id = ANY($2::uuid[]))', [userId, keep.map((l) => l.productId)]);
    for (const l of lines) {
      const p = products.get(l.productId);
      if (!p || !keep.includes(l)) { notices.push({ productId: l.productId, reason: 'UNAVAILABLE' }); continue; }
      const quantity = Math.min(l.quantity, Number(p.max_quantity));
      if (quantity < l.quantity) notices.push({ productId: l.productId, reason: 'LIMIT' });
      // updated_at moves only when the line really changes (removePurchasedFromCart relies on it).
      await c.query(`INSERT INTO cart_items(user_id,product_id,quantity) VALUES($1,$2,$3)
        ON CONFLICT (user_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity,
          updated_at=CASE WHEN cart_items.quantity<>EXCLUDED.quantity THEN now() ELSE cart_items.updated_at END`, [userId, l.productId, quantity]);
    }
    return { lines: await readIn(c, userId), notices };
  });
}

/**
 * Sign-in: the browser's guest cart joins the account cart, once per guest cart
 * (guestCartId), so repeated callbacks or a second tab cannot add it twice.
 * Only lines that can be bought now are added; the same product in both carts is
 * combined within the per-ticket limit, the cart limit and what is still available.
 * Everything else is reported back, never held or booked.
 */
export async function mergeGuestCart(userId: string, guestCartId: unknown, raw: unknown) {
  const id = String(guestCartId ?? '');
  requireValue(/^[A-Za-z0-9_-]{8,64}$/.test(id), 'Invalid guest cart.', 400);
  const lines = parseLines(raw);
  return transaction(async (c) => {
    await lockCart(c, userId);
    const first = await one(c, 'INSERT INTO cart_merges(user_id,guest_cart_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING guest_cart_id', [userId, id]);
    if (!first) return { lines: await readIn(c, userId), notices: [] as CartNotice[], merged: false };
    await c.query(`DELETE FROM cart_items ci WHERE ci.user_id=$1 AND ${EXPIRED}`, [userId]);
    const existing = new Map((await c.query<{ product_id: string; quantity: number }>('SELECT product_id, quantity FROM cart_items WHERE user_id=$1', [userId])).rows
      .map((r) => [r.product_id, Number(r.quantity)]));
    const products = await loadProducts(c, lines.map((l) => l.productId));
    const notices: CartNotice[] = [];
    let total = [...existing.values()].reduce((n, q) => n + q, 0);
    for (const l of lines) {
      const p = products.get(l.productId);
      const s = lineState(p);
      if (!p || s.state === 'UNAVAILABLE') { notices.push({ productId: l.productId, reason: 'UNAVAILABLE' }); continue; }
      if (s.state === 'CLOSED') { notices.push({ productId: l.productId, reason: 'CLOSED' }); continue; }
      if (s.state === 'SOLD_OUT') { notices.push({ productId: l.productId, reason: 'SOLD_OUT' }); continue; }
      const had = existing.get(l.productId) ?? 0;
      const wanted = had + l.quantity;
      const allowed = Math.min(wanted, Number(p.max_quantity), Math.max(had, s.available), had + (MAX_CART_TICKETS - total));
      if (allowed < wanted) notices.push({ productId: l.productId, reason: allowed <= had ? 'LIMIT' : 'REDUCED' });
      if (allowed <= had) continue;
      total += allowed - had;
      await c.query(`INSERT INTO cart_items(user_id,product_id,quantity) VALUES($1,$2,$3)
        ON CONFLICT (user_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now()`, [userId, l.productId, allowed]);
    }
    return { lines: await readIn(c, userId), notices, merged: true };
  });
}

/**
 * After a checkout is paid: its lines leave the account cart (same product and
 * quantity, unchanged since the checkout started), so a paid cart is never
 * offered again even if the browser never came back. Idempotent.
 */
export async function removePurchasedFromCart(checkoutId: string) {
  await query(
    `DELETE FROM cart_items ci USING bookings b, checkouts co
     WHERE co.id=$1 AND b.checkout_id=co.id AND b.status='CONFIRMED'
       AND ci.user_id=co.user_id AND ci.product_id=b.product_id AND ci.quantity=b.quantity AND ci.updated_at<=co.created_at`,
    [checkoutId],
  );
}
