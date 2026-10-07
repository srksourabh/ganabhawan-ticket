'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useCart, type CartItem } from '@/components/CartProvider';
import { useLocale } from '@/components/LocaleProvider';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { dateLocale, kindLabel, zoneLabel, type MessageKey } from '@/lib/i18n';
import { createClientCheckout, createClientCheckoutOrder, payExistingOrder, prefillFromContact } from '@/lib/razorpay-checkout';

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

type LineStatus = 'pending' | 'processing' | 'held' | 'ordered' | 'confirmed' | 'error';
type LineState = {
  item: CartItem;
  status: LineStatus;
  message?: string;
};

/** crypto.randomUUID is missing on older Safari and on plain-http origins. */
function newCheckoutKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return 'chk-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function updateAll(lines: LineState[], patch: Partial<LineState>): LineState[] {
  return lines.map((line) => ({ ...line, ...patch }));
}

const STATUS_KEYS: Record<LineStatus, MessageKey> = {
  pending: 'checkout.status.pending',
  processing: 'checkout.status.processing',
  held: 'checkout.status.held',
  ordered: 'checkout.status.ordered',
  confirmed: 'checkout.status.confirmed',
  error: 'checkout.status.error',
};

export default function CheckoutPage() {
  const cart = useCart();
  const router = useRouter();
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const [authChecked, setAuthChecked] = useState(false);
  const [lines, setLines] = useState<LineState[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [me, setMe] = useState<{ contact?: string; name?: string }>({});
  const runningRef = useRef(false);
  /** One key per checkout attempt: a retried request reuses it; after a failure the next attempt gets a new one. */
  const checkoutKey = useRef(newCheckoutKey());
  const [serverTotal, setServerTotal] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => {
        if (res.status === 401) {
          router.replace('/login?next=/cart/checkout');
          return;
        }
        return res.json();
      })
      .then((body) => {
        if (body?.contact) setMe({ contact: body.contact, name: body.name });
        setAuthChecked(true);
      })
      .catch(() => setAuthChecked(true));
  }, [router]);

  useEffect(() => {
    if (!running && !done) setLines(cart.items.map((item) => ({ item, status: 'pending' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.items, running]);

  /**
   * ONE checkout for the whole cart: the server holds every line atomically,
   * prices them, and creates ONE Razorpay order for the total. The cart is
   * cleared only after the server confirms the booking; a dismissed or failed
   * payment leaves the cart as it is, ready to retry.
   */
  async function runCheckout() {
    if (runningRef.current) return; // double-click / repeated submit
    runningRef.current = true;
    setRunning(true);
    setDone(false);
    let checkoutId: string | null = null;
    try {
      setLines((prev) => updateAll(prev, { status: 'processing', message: undefined }));
      // Lead capture per line (the checkout name becomes each booking's holder).
      const attempts = await Promise.all(lines.map(async (line) => {
        const res = await fetch('/api/booking-attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: me.name, contact: me.contact, productId: line.item.productId, quantity: line.item.quantity }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Enter your name and mobile or email before checkout.');
        return { productId: line.item.productId, attemptId: body.id as string | undefined };
      }));
      const checkout = await createClientCheckout(
        lines.map((line) => ({
          productId: line.item.productId,
          quantity: line.item.quantity,
          version: line.item.version,
          attemptId: attempts.find((a) => a.productId === line.item.productId)?.attemptId,
        })),
        checkoutKey.current,
      );
      if (checkout.unauthenticated) { router.replace('/login?next=/cart/checkout'); throw new Error('Sign-in required.'); }
      checkoutId = checkout.id;
      setServerTotal(checkout.total);
      setLines((prev) => updateAll(prev, { status: 'held' }));
      const order = await createClientCheckoutOrder(checkout.id);
      setLines((prev) => updateAll(prev, { status: 'ordered' }));
      await payExistingOrder(order, {
        name: locale === 'bn' ? FESTIVAL_BN : FESTIVAL,
        description: lines.length === 1 ? `${lines[0].item.name} × ${lines[0].item.quantity}` : `${lines.length} ticket types · ${checkout.reference}`,
        ...prefillFromContact(me.contact, me.name),
        prefillEmail: me.contact?.includes('@') ? me.contact : undefined,
        prefillContact: me.contact && !me.contact.includes('@') ? me.contact : undefined,
        prefillName: me.name,
      });
      // Confirmed by the server (payExistingOrder throws unless status is CONFIRMED).
      setLines((prev) => updateAll(prev, { status: 'confirmed', message: checkout.reference }));
      cart.clear();
      router.push(`/receipts/${checkoutId}`);
    } catch (error) {
      const refund = error instanceof Error && error.message === 'REFUND_REQUIRED';
      // Next attempt is a new request; the server reuses the same live checkout
      // if the cart is unchanged, or replaces it if the cart changed.
      checkoutKey.current = newCheckoutKey();
      setLines((prev) => updateAll(prev, {
        status: 'error',
        message: refund ? t('pay.refunded') : error instanceof Error && /cancelled/i.test(error.message) ? t('pay.cancelled') : error instanceof Error ? error.message : t('pay.failed'),
      }));
      if (refund && checkoutId) router.push(`/receipts/${checkoutId}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setDone(true);
    }
  }

  if (!authChecked) {
    return (
      <main className="page-pad">
        <section className="container" style={{ maxWidth: 560 }}>
          <p role="status">{t('checkout.checking')}</p>
        </section>
      </main>
    );
  }

  if (lines.length === 0) {
    return (
      <main className="page-pad">
        <section className="container" style={{ maxWidth: 560 }}>
          <div className="card stack" style={{ textAlign: 'center' }}>
            <p>{done ? t('checkout.processed') : t('checkout.empty')}</p>
            <Link href="/catalogue" className="btn btn--primary">{t('cart.browse')}</Link>
          </div>
        </section>
      </main>
    );
  }

  // The server's total is authoritative once a checkout exists; before that, the cart's estimate is shown.
  const total = serverTotal ?? lines.reduce((sum, l) => sum + l.item.unitPrice * l.item.quantity, 0);

  return (
    <main className="page-pad">
      <section className="container" style={{ maxWidth: 640 }}>
        <p className="eyebrow">{locale === 'bn' ? FESTIVAL_BN : FESTIVAL}</p>
        <h1 className="h2">{t('checkout.title')}</h1>
        <p className="muted">{t('checkout.intro')}</p>

        <div className="stack">
          {lines.map((line) => (
            <article key={line.item.productId} className="card stack stack--sm">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.75rem', flexWrap: 'wrap' }}>
                <div>
                  <p className="eyebrow">{kindLabel(locale, line.item.kind)} · {zoneLabel(locale, line.item.category)}</p>
                  <h3 className="h3">{line.item.name}</h3>
                  {line.item.showTitle && (
                    <p className="muted">
                      {line.item.showTitle} · {new Date(line.item.startsAt).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
                    </p>
                  )}
                  <p>{line.item.quantity} × {money(line.item.unitPrice, dl)}</p>
                </div>
                <span
                  className={`banner ${line.status === 'error' ? 'banner--err' : line.status === 'confirmed' ? 'banner--ok' : ''}`}
                  role="status"
                >
                  {t(STATUS_KEYS[line.status])}
                </span>
              </div>
            </article>
          ))}

          {lines[0]?.message && (
            <p role={lines[0].status === 'error' ? 'alert' : 'status'} className={lines[0].status === 'error' ? 'banner banner--err' : 'muted'}>
              {lines[0].status === 'confirmed' ? t('checkout.ref', { ref: lines[0].message }) : lines[0].message}
            </p>
          )}

          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700 }}>
            <span>{t('cart.total')}</span>
            <span>{money(total, dl)}</span>
          </div>

          <button type="button" className="btn btn--primary btn--block" disabled={running} onClick={runCheckout}>
            {running ? t('checkout.processing') : t('checkout.pay', { amount: money(total, dl) })}
          </button>

          {done && lines.some((l) => l.status === 'error') && (
            <p className="muted">{t('checkout.retryHint')}</p>
          )}
        </div>
      </section>
    </main>
  );
}
