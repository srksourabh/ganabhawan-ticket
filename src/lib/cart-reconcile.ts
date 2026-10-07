/**
 * The cart lives in the browser; payments are confirmed on the server (callback,
 * webhook or reconciliation). The cart remembers the checkout it started and
 * asks the server for its state, so a payment confirmed while the tab was
 * closed, on another tab, or by the webhook still clears exactly the lines that
 * were paid. The server's checkout status is the only signal used.
 */
export const PENDING_CHECKOUT_KEY = 'samatat-pending-checkout';

export type PendingCheckout = { id: string; reference: string; lines: { productId: string; quantity: number }[] };
export type CheckoutOutcome = 'paid' | 'refunded' | 'open' | 'closed';
type Line = { productId: string; quantity: number };

export function outcomeOf(status: string | undefined): CheckoutOutcome {
  if (status === 'CONFIRMED') return 'paid';
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
  if (outcome !== 'paid') return { items, outcome, keepPending: outcome === 'open' };
  const paid = new Map(pending.lines.map((l) => [l.productId, l.quantity]));
  return { items: items.filter((item) => paid.get(item.productId) !== item.quantity), outcome, keepPending: false };
}

export function readPendingCheckout(): PendingCheckout | null {
  try {
    const raw = window.localStorage.getItem(PENDING_CHECKOUT_KEY);
    const parsed = raw ? (JSON.parse(raw) as PendingCheckout) : null;
    return parsed && typeof parsed.id === 'string' && Array.isArray(parsed.lines) ? parsed : null;
  } catch {
    return null;
  }
}

export function writePendingCheckout(pending: PendingCheckout | null) {
  try {
    if (pending) window.localStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(pending));
    else window.localStorage.removeItem(PENDING_CHECKOUT_KEY);
  } catch {
    // Storage unavailable: the cart simply won't auto-reconcile.
  }
}
