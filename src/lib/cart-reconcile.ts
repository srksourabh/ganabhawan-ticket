/**
 * The cart lives in the browser; payments are confirmed on the server (callback,
 * webhook or reconciliation). The cart remembers the checkout it started and
 * asks the server for its state, so a payment confirmed while the tab was
 * closed, on another tab, or by the webhook still clears exactly the lines that
 * were paid. The server's checkout status is the only signal used.
 */

export type PendingCheckout = { id: string; reference: string; lines: { productId: string; quantity: number }[] };
export type CheckoutOutcome = 'paid' | 'refunded' | 'open' | 'closed';
type Line = { productId: string; quantity: number };

export function outcomeOf(status: string | undefined): CheckoutOutcome {
  // PARTIALLY_CANCELLED: paid; a show was cancelled afterwards for some lines (refunded), the rest stand.
  if (status === 'CONFIRMED' || status === 'PARTIALLY_CANCELLED') return 'paid';
  if (status === 'REFUND_REQUIRED' || status === 'REFUNDED') return 'refunded';
  if (status === 'HELD' || status === 'PAYMENT_PENDING') return 'open';
  return 'closed';
}

/**
 * Removes only the lines the checkout actually paid for (same product AND same
 * quantity). Lines added later, or a line whose quantity the customer changed
 * after starting checkout, stay in the cart.
 */
export function reconcileCart<T extends Line>(items: T[], pending: PendingCheckout, status: string | undefined) {
  const outcome = outcomeOf(status);
  // EXPIRED is not final: a payment captured after the hold lapsed can still
  // confirm the checkout (or refund it), so keep watching it. CANCELLED
  // (superseded/show cancelled) is final: a late payment on it is refunded.
  if (outcome !== 'paid') return { items, outcome, keepPending: outcome === 'open' || status === 'EXPIRED' };
  const paid = new Map(pending.lines.map((l) => [l.productId, l.quantity]));
  return { items: items.filter((item) => paid.get(item.productId) !== item.quantity), outcome, keepPending: false };
}

/** `key` is the signed-in account's pending-checkout key (cart-storage.ts pendingKey). */
export function readPendingCheckout(key: string | null): PendingCheckout | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as PendingCheckout) : null;
    return parsed && typeof parsed.id === 'string' && Array.isArray(parsed.lines) ? parsed : null;
  } catch {
    return null;
  }
}

export function writePendingCheckout(key: string | null, pending: PendingCheckout | null) {
  if (!key) return;
  try {
    if (pending) window.localStorage.setItem(key, JSON.stringify(pending));
    else window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the cart simply won't auto-reconcile.
  }
}
