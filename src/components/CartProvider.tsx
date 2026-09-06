'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY, t, type Locale } from '@/lib/i18n';

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
    let result: MutationResult = { ok: true };
    setItems((previous) => {
      const currentTotal = previous.reduce((sum, i) => sum + i.quantity, 0);
      const existing = previous.find((i) => i.productId === item.productId);
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      const othersTotal = currentTotal - (existing?.quantity ?? 0);
      if (othersTotal + nextQuantity > MAX_TICKETS) {
        result = { ok: false, message: limitMessage() };
        return previous;
      }
      if (existing) {
        return previous.map((i) => (i.productId === item.productId ? { ...i, ...item, quantity: nextQuantity } : i));
      }
      return [...previous, { ...item, quantity: nextQuantity }];
    });
    return result;
  }, []);

  const updateQty = useCallback((productId: string, quantity: number): MutationResult => {
    if (quantity <= 0) {
      remove(productId);
      return { ok: true };
    }
    let result: MutationResult = { ok: true };
    setItems((previous) => {
      const existing = previous.find((i) => i.productId === productId);
      if (!existing) return previous;
      const currentTotal = previous.reduce((sum, i) => sum + i.quantity, 0);
      const othersTotal = currentTotal - existing.quantity;
      if (othersTotal + quantity > MAX_TICKETS) {
        result = { ok: false, message: limitMessage() };
        return previous;
      }
      return previous.map((i) => (i.productId === productId ? { ...i, quantity } : i));
    });
    return result;
  }, [remove]);

  const clear = useCallback(() => setItems([]), []);

  const total = useMemo(() => items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0), [items]);
  const count = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);

  const value = useMemo<CartContextValue>(
    () => ({ items, add, remove, updateQty, clear, total, count, maxTickets: MAX_TICKETS }),
    [items, add, remove, updateQty, clear, total, count],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider.');
  return ctx;
}
