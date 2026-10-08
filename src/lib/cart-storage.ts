/**
 * What the browser keeps for carts. Only the GUEST cart lives here (plus a random
 * id that lets the server merge it into an account exactly once). A signed-in
 * customer's cart lives on the server (account-cart.ts) and is never written to
 * the browser, so it survives sign-out and session expiry and can never be seen by
 * the next person using the same device. Other tabs of the same account are told
 * to re-read it through a content-free "changed" ping.
 *
 * The server never trusts any of this: prices and inventory are re-checked when
 * the cart is merged and when the checkout is created.
 */
export type CartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>;
/** null = guest; a string = the signed-in user's id. */
export type CartOwner = string | null;

export const GUEST_CART_KEY = 'samatat-cart:guest';
const GUEST_ID_KEY = 'samatat-cart:guest-id';
/** Written (timestamp only, no cart content) when an account cart changes, so other tabs re-read it. */
export const ACCOUNT_CART_PING_KEY = 'samatat-cart:changed';
const LEGACY_CART_KEY = 'samatat-cart';
const LEGACY_PENDING_KEY = 'samatat-pending-checkout';
/** Per-account browser carts from an earlier version: stale, and private to another account. */
const STALE_ACCOUNT_PREFIX = 'samatat-cart:user:';

/** Checkouts need an account, so only accounts have a pending checkout (ids only, no cart content). */
export function pendingKey(owner: CartOwner) {
  return owner ? `samatat-pending-checkout:user:${owner}` : null;
}

export function readGuestItems<T>(storage: CartStorage): T[] {
  try {
    const parsed = JSON.parse(storage.getItem(GUEST_CART_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function writeGuestItems<T>(storage: CartStorage, items: T[]) {
  try {
    if (items.length) storage.setItem(GUEST_CART_KEY, JSON.stringify(items));
    else storage.removeItem(GUEST_CART_KEY);
  } catch {
    // Storage unavailable (private browsing, quota): the guest cart just won't persist.
  }
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The id the server uses to merge this guest cart once (stable until the cart is merged). */
export function guestCartId(storage: CartStorage) {
  try {
    const existing = storage.getItem(GUEST_ID_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const id = randomId();
    storage.setItem(GUEST_ID_KEY, id);
    return id;
  } catch {
    return randomId();
  }
}

/** After a successful merge: the guest cart is emptied and gets a new id. */
export function resetGuestCart(storage: CartStorage) {
  try {
    storage.removeItem(GUEST_CART_KEY);
    storage.removeItem(GUEST_ID_KEY);
  } catch {
    // ignore
  }
}

/**
 * Old browser data: the unowned cart becomes the guest cart (it was never an
 * account's); old per-account carts and the old shared pending checkout are deleted.
 */
export function cleanupStaleCartStorage(storage: CartStorage) {
  try {
    const legacy = storage.getItem(LEGACY_CART_KEY);
    if (legacy !== null) {
      if (storage.getItem(GUEST_CART_KEY) === null) storage.setItem(GUEST_CART_KEY, legacy);
      storage.removeItem(LEGACY_CART_KEY);
    }
    storage.removeItem(LEGACY_PENDING_KEY);
    if (storage.key && typeof storage.length === 'number') {
      const stale: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key?.startsWith(STALE_ACCOUNT_PREFIX)) stale.push(key);
      }
      for (const key of stale) storage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

/** Sign-out / session end: the account's pending-checkout note leaves this browser (its cart is on the server). */
export function forgetAccountLocally(storage: CartStorage, owner: CartOwner) {
  const key = pendingKey(owner);
  if (!key) return;
  try { storage.removeItem(key); } catch { /* ignore */ }
}
