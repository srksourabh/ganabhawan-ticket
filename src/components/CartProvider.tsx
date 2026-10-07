'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY, t, type Locale } from '@/lib/i18n';
import {
  PENDING_CHECKOUT_KEY, readPendingCheckout, reconcileCart, writePendingCheckout,
  type CheckoutOutcome, type PendingCheckout,
} from '@/lib/cart-reconcile';

export type CartItem = {
  productId: string;
  name: string;
  category: string;
  kind: string;
  showTitle: string;
  startsAt: string;
  unitPrice: number;
  version: number;
  quantity: number;
};

type MutationResult = { ok: boolean; message?: string };

type CartContextValue = {
  items: CartItem[];
  add: (item: Omit<CartItem, 'quantity'>, quantity?: number) => MutationResult;
  remove: (productId: string) => void;
  updateQty: (productId: string, quantity: number) => MutationResult;
  clear: () => void;
  /** Remembers the server checkout started from this cart (for reconciliation). */
  rememberCheckout: (pending: PendingCheckout) => void;
  /** Asks the server about the remembered checkout; removes lines only if it is CONFIRMED. */
  reconcileWithServer: () => Promise<CheckoutOutcome | null>;
  /** Last checkout the server reported as finished (shown on the cart page). */
  lastOrder: { checkoutId: string; reference: string; outcome: CheckoutOutcome } | null;
  dismissLastOrder: () => void;
  total: number;
  count: number;
  maxTickets: number;
};

const STORAGE_KEY = 'samatat-cart';
const MAX_TICKETS = 6;

function clientLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const fromStorage = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(fromStorage)) return fromStorage;
    const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
    const fromCookie = match?.[1] ? decodeURIComponent(match[1]) : null;
    if (isLocale(fromCookie)) return fromCookie;
  } catch {
    // ignore
  }
  return 'en';
}

function limitMessage() {
  return t(clientLocale(), 'cart.limit');
}
const CartContext = createContext<CartContextValue | null>(null);

function readStoredCart(): CartItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartItem[]) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Load persisted cart once on mount (client only — avoids SSR mismatch).
  // Syncing from the localStorage external system; cannot read it during SSR render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(readStoredCart());
    setHydrated(true);
  }, []);

  // Persist on every change, once hydrated.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Storage may be unavailable (private browsing, quota) — cart just won't persist.
    }
  }, [items, hydrated]);

  // Keep multiple tabs in sync.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) setItems(readStoredCart());
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const remove = useCallback((productId: string) => {
    setItems((previous) => previous.filter((item) => item.productId !== productId));
  }, []);

  const add = useCallback((item: Omit<CartItem, 'quantity'>, quantity = 1): MutationResult => {
    const existing = items.find((i) => i.productId === item.productId);
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    const othersTotal = items.reduce((sum, i) => sum + (i.productId === item.productId ? 0 : i.quantity), 0);
    if (othersTotal + nextQuantity > MAX_TICKETS) {
      return { ok: false, message: limitMessage() };
    }
    setItems((previous) => {
      const match = previous.find((i) => i.productId === item.productId);
      if (match) {
        return previous.map((i) => (i.productId === item.productId ? { ...i, ...item, quantity: nextQuantity } : i));
      }
      return [...previous, { ...item, quantity: nextQuantity }];
    });
    return { ok: true };
  }, [items]);

  const updateQty = useCallback((productId: string, quantity: number): MutationResult => {
    if (quantity <= 0) {
      remove(productId);
      return { ok: true };
    }
    const existing = items.find((i) => i.productId === productId);
    if (!existing) return { ok: true };
    const othersTotal = items.reduce((sum, i) => sum + (i.productId === productId ? 0 : i.quantity), 0);
    if (othersTotal + quantity > MAX_TICKETS) {
      return { ok: false, message: limitMessage() };
    }
    setItems((previous) => previous.map((i) => (i.productId === productId ? { ...i, quantity } : i)));
    return { ok: true };
  }, [items, remove]);

  const clear = useCallback(() => setItems([]), []);

  const [lastOrder, setLastOrder] = useState<CartContextValue['lastOrder']>(null);
  const rememberCheckout = useCallback((pending: PendingCheckout) => writePendingCheckout(pending), []);
  const dismissLastOrder = useCallback(() => setLastOrder(null), []);

  // Server truth wins: only a CONFIRMED checkout removes (exactly its) lines.
  const reconcileWithServer = useCallback(async (): Promise<CheckoutOutcome | null> => {
    const pending = readPendingCheckout();
    if (!pending) return null;
    let status: string | undefined;
    try {
      const res = await fetch(`/api/checkouts/${encodeURIComponent(pending.id)}`, { cache: 'no-store' });
      if (res.status === 401) return null; // signed out: keep everything, check again after sign-in
      if (res.status === 404) { writePendingCheckout(null); return 'closed'; } // not this user's / gone
      if (!res.ok) return null; // transient: try again later
      status = ((await res.json()) as { status?: string }).status;
    } catch {
      return null;
    }
    // Re-read the remembered checkout: another tab may have settled it meanwhile.
    if (readPendingCheckout()?.id !== pending.id) return null;
    const result = reconcileCart(readStoredCart(), pending, status);
    if (!result.keepPending) writePendingCheckout(null);
    if (result.outcome === 'paid' || result.outcome === 'refunded') {
      setItems(result.items);
      setLastOrder({ checkoutId: pending.id, reference: pending.reference, outcome: result.outcome });
    }
    return result.outcome;
  }, []);

  // Reconcile once the cart is loaded, whenever the tab regains focus, and when
  // another tab changes the remembered checkout.
  useEffect(() => {
    if (!hydrated) return;
    // Syncing from an external system (the server's checkout state); state is set after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reconcileWithServer();
    const onFocus = () => { void reconcileWithServer(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void reconcileWithServer(); };
    const onStorage = (event: StorageEvent) => { if (event.key === PENDING_CHECKOUT_KEY) void reconcileWithServer(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }, [hydrated, reconcileWithServer]);

  const total = useMemo(() => items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0), [items]);
  const count = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);

  const value = useMemo<CartContextValue>(
    () => ({ items, add, remove, updateQty, clear, rememberCheckout, reconcileWithServer, lastOrder, dismissLastOrder, total, count, maxTickets: MAX_TICKETS }),
    [items, add, remove, updateQty, clear, rememberCheckout, reconcileWithServer, lastOrder, dismissLastOrder, total, count],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider.');
  return ctx;
}
