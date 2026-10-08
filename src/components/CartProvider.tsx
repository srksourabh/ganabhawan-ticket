'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { isLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY, t, type Locale } from '@/lib/i18n';
import {
  readPendingCheckout, reconcileCart, writePendingCheckout,
  type CheckoutOutcome, type PendingCheckout,
} from '@/lib/cart-reconcile';
import {
  ACCOUNT_CART_PING_KEY, GUEST_CART_KEY, cleanupStaleCartStorage, forgetAccountLocally, guestCartId, pendingKey,
  readGuestItems, resetGuestCart, writeGuestItems, type CartOwner,
} from '@/lib/cart-storage';

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
  /** Server-decided sale state (signed-in carts): only SELLABLE lines can be paid for. */
  state?: 'SELLABLE' | 'SOLD_OUT' | 'CLOSED' | 'UNAVAILABLE';
};

/** Why a line could not join the cart (guest→account merge) or was limited. */
export type CartNotice = { productId: string; reason: 'UNAVAILABLE' | 'CLOSED' | 'SOLD_OUT' | 'REDUCED' | 'LIMIT' };

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
  /** Lines the server could not add or had to limit (e.g. after sign-in). */
  notices: CartNotice[];
  dismissNotices: () => void;
  /** Sign-out: the account cart stays on the server; this browser shows the guest cart again. */
  signedOut: () => void;
  total: number;
  count: number;
  maxTickets: number;
};

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

function storage() {
  return window.localStorage;
}

/** Who is signed in (null = guest; undefined = could not tell, e.g. offline). */
async function fetchOwner(): Promise<CartOwner | undefined> {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (res.status === 401) return null;
    if (!res.ok) return undefined;
    const body = (await res.json()) as { id?: string };
    return typeof body.id === 'string' ? body.id : null;
  } catch {
    return undefined;
  }
}

type ServerLine = {
  productId: string; quantity: number; name: string; nameBn: string; category: string; kind: string;
  unitPrice: number; version: number; showTitle: string; showTitleBn: string; startsAt: string; state: CartItem['state'];
};
type ServerCart = { lines: ServerLine[]; notices?: CartNotice[] };

function fromServer(line: ServerLine): CartItem {
  const bn = clientLocale() === 'bn';
  return {
    productId: line.productId,
    name: bn && line.nameBn ? line.nameBn : line.name,
    category: line.category,
    kind: line.kind,
    showTitle: line.kind === 'SEASON' ? t(clientLocale(), 'catalogue.season') : (bn && line.showTitleBn ? line.showTitleBn : line.showTitle),
    startsAt: line.startsAt,
    unitPrice: line.unitPrice,
    version: line.version,
    quantity: line.quantity,
    state: line.state,
  };
}

async function cartRequest(url: string, init?: RequestInit): Promise<ServerCart | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    if (!res.ok) return null;
    return (await res.json()) as ServerCart;
  } catch {
    return null;
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const itemsRef = useRef<CartItem[]>([]);
  // The cart shown belongs to exactly one identity. A guest cart lives in this browser;
  // an account cart lives on the server only. Until the identity is known nothing is
  // shown or saved, so one account's cart is never shown to anyone else.
  const [owner, setOwner] = useState<CartOwner | undefined>(undefined);
  const ownerRef = useRef<CartOwner | undefined>(undefined);
  const [notices, setNotices] = useState<CartNotice[]>([]);
  const saveSeq = useRef(0);
  const hydrated = owner !== undefined;
  const pathname = usePathname();

  const show = useCallback((next: CartItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  /** Applies a server cart if it is still for the account that asked (and the newest save). */
  const applyServer = useCallback((account: string, cart: ServerCart | null, seq?: number) => {
    if (!cart || ownerRef.current !== account || (seq !== undefined && seq !== saveSeq.current)) return;
    show(cart.lines.map(fromServer));
    if (cart.notices?.length) setNotices(cart.notices);
  }, [show]);

  const pingOtherTabs = useCallback(() => {
    try { storage().setItem(ACCOUNT_CART_PING_KEY, String(Date.now())); } catch { /* ignore */ }
  }, []);

  /** Signed in: merge the guest cart once (server-side, idempotent), else just read the account cart. */
  const loadAccount = useCallback(async (account: string) => {
    const guest = readGuestItems<CartItem>(storage());
    if (guest.length) {
      const merged = await cartRequest('/api/cart/merge', {
        method: 'POST',
        body: JSON.stringify({ guestCartId: guestCartId(storage()), lines: guest.map((i) => ({ productId: i.productId, quantity: i.quantity })) }),
      });
      if (merged) {
        resetGuestCart(storage());
        applyServer(account, merged);
        pingOtherTabs();
        return;
      }
    }
    applyServer(account, await cartRequest('/api/cart'));
  }, [applyServer, pingOtherTabs]);

  const switchOwner = useCallback((next: CartOwner) => {
    const previous = ownerRef.current;
    if (previous === next) {
      if (next) void loadAccount(next); // same account: refresh (another tab or device may have changed it)
      return;
    }
    // Leaving an account (sign-out, expired session, another account): its cart stays
    // on the server and nothing of it remains in this browser.
    if (previous) forgetAccountLocally(storage(), previous);
    ownerRef.current = next;
    setOwner(next);
    setNotices([]);
    if (next === null) {
      show(readGuestItems<CartItem>(storage()));
    } else {
      show([]);
      void loadAccount(next);
    }
  }, [loadAccount, show]);

  // Identity check on load, on every navigation (sign-in/out redirect), on focus and
  // when the tab becomes visible (signed in or out in another tab).
  useEffect(() => {
    cleanupStaleCartStorage(storage());
    let live = true;
    const check = () => { void fetchOwner().then((next) => { if (live && next !== undefined) switchOwner(next); }); };
    check();
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pathname, switchOwner]);

  // Other tabs: the guest cart through storage, an account cart by re-reading the server.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      const current = ownerRef.current;
      if (current === null && event.key === GUEST_CART_KEY) show(readGuestItems<CartItem>(storage()));
      if (current && event.key === ACCOUNT_CART_PING_KEY) void loadAccount(current);
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [loadAccount, show]);

  /** Every change: a guest cart is saved in this browser, an account cart on the server. */
  const commit = useCallback((next: CartItem[]) => {
    show(next);
    const current = ownerRef.current;
    if (current === null) {
      writeGuestItems(storage(), next);
    } else if (current) {
      const seq = ++saveSeq.current;
      void cartRequest('/api/cart', { method: 'PUT', body: JSON.stringify({ lines: next.map((i) => ({ productId: i.productId, quantity: i.quantity })) }) })
        .then((cart) => { applyServer(current, cart, seq); if (cart) pingOtherTabs(); });
    }
  }, [applyServer, pingOtherTabs, show]);

  const signedOut = useCallback(() => {
    const current = ownerRef.current;
    if (current) forgetAccountLocally(storage(), current);
    ownerRef.current = null;
    setOwner(null);
    setNotices([]);
    show(readGuestItems<CartItem>(storage()));
  }, [show]);

  const remove = useCallback((productId: string) => {
    commit(itemsRef.current.filter((item) => item.productId !== productId));
  }, [commit]);

  const add = useCallback((item: Omit<CartItem, 'quantity'>, quantity = 1): MutationResult => {
    const current = itemsRef.current;
    const existing = current.find((i) => i.productId === item.productId);
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    const othersTotal = current.reduce((sum, i) => sum + (i.productId === item.productId ? 0 : i.quantity), 0);
    if (othersTotal + nextQuantity > MAX_TICKETS) {
      return { ok: false, message: limitMessage() };
    }
    commit(existing
      ? current.map((i) => (i.productId === item.productId ? { ...i, ...item, quantity: nextQuantity } : i))
      : [...current, { ...item, quantity: nextQuantity }]);
    return { ok: true };
  }, [commit]);

  const updateQty = useCallback((productId: string, quantity: number): MutationResult => {
    if (quantity <= 0) {
      remove(productId);
      return { ok: true };
    }
    const current = itemsRef.current;
    if (!current.some((i) => i.productId === productId)) return { ok: true };
    const othersTotal = current.reduce((sum, i) => sum + (i.productId === productId ? 0 : i.quantity), 0);
    if (othersTotal + quantity > MAX_TICKETS) {
      return { ok: false, message: limitMessage() };
    }
    commit(current.map((i) => (i.productId === productId ? { ...i, quantity } : i)));
    return { ok: true };
  }, [commit, remove]);

  const clear = useCallback(() => commit([]), [commit]);

  const [lastOrder, setLastOrder] = useState<CartContextValue['lastOrder']>(null);
  const rememberCheckout = useCallback((pending: PendingCheckout) => writePendingCheckout(pendingKey(ownerRef.current ?? null), pending), []);
  const dismissLastOrder = useCallback(() => setLastOrder(null), []);
  const dismissNotices = useCallback(() => setNotices([]), []);

  // Server truth wins: only a CONFIRMED checkout removes (exactly its) lines.
  const reconcileWithServer = useCallback(async (): Promise<CheckoutOutcome | null> => {
    const account = ownerRef.current ?? null;
    const key = pendingKey(account);
    const pending = readPendingCheckout(key);
    if (!pending) return null;
    let status: string | undefined;
    try {
      const res = await fetch(`/api/checkouts/${encodeURIComponent(pending.id)}`, { cache: 'no-store' });
      if (res.status === 401) return null; // signed out: keep everything, check again after sign-in
      if (res.status === 404) { writePendingCheckout(key, null); return 'closed'; } // not this user's / gone
      if (!res.ok) return null; // transient: try again later
      status = ((await res.json()) as { status?: string }).status;
    } catch {
      return null;
    }
    // The account changed meanwhile, or another tab settled it: leave it alone.
    if (ownerRef.current !== account || readPendingCheckout(key)?.id !== pending.id) return null;
    const result = reconcileCart(itemsRef.current, pending, status);
    if (!result.keepPending) writePendingCheckout(key, null);
    if (result.outcome === 'paid' || result.outcome === 'refunded') {
      commit(result.items);
      setLastOrder({ checkoutId: pending.id, reference: pending.reference, outcome: result.outcome });
    }
    return result.outcome;
  }, [commit]);

  // Reconcile once the cart is loaded, whenever the tab regains focus, and when
  // another tab changes the remembered checkout.
  useEffect(() => {
    if (!hydrated) return;
    // Syncing from an external system (the server's checkout state); state is set after the await.
    void reconcileWithServer();
    const onFocus = () => { void reconcileWithServer(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void reconcileWithServer(); };
    const onStorage = (event: StorageEvent) => { if (event.key === pendingKey(ownerRef.current ?? null)) void reconcileWithServer(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }, [hydrated, owner, reconcileWithServer]);

  const total = useMemo(() => items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0), [items]);
  const count = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);

  const value = useMemo<CartContextValue>(
    () => ({ items, add, remove, updateQty, clear, rememberCheckout, reconcileWithServer, lastOrder, dismissLastOrder, notices, dismissNotices, signedOut, total, count, maxTickets: MAX_TICKETS }),
    [items, add, remove, updateQty, clear, rememberCheckout, reconcileWithServer, lastOrder, dismissLastOrder, notices, dismissNotices, signedOut, total, count],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider.');
  return ctx;
}
