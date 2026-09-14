'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useCart, type CartItem } from '@/components/CartProvider';
import { useLocale } from '@/components/LocaleProvider';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { dateLocale, kindLabel, zoneLabel, type MessageKey } from '@/lib/i18n';
import { confirmRazorpayPayment, openRazorpayCheckout } from '@/lib/razorpay-checkout';

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

type LineStatus = 'pending' | 'processing' | 'held' | 'ordered' | 'confirmed' | 'error';
type LineState = { item: CartItem; status: LineStatus; message?: string };

function updateLine(lines: LineState[], productId: string, patch: Partial<LineState>): LineState[] {
  return lines.map((line) => (line.item.productId === productId ? { ...line, ...patch } : line));
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

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => {
        if (res.status === 401) {
          router.replace('/login?next=/cart/checkout');
          return;
        }
        setAuthChecked(true);
      })
      .catch(() => setAuthChecked(true));
  }, [router]);

  useEffect(() => {
    if (!running && !done) setLines(cart.items.map((item) => ({ item, status: 'pending' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.items, running]);

  async function checkoutLine(item: CartItem): Promise<void> {
    setLines((prev) => updateLine(prev, item.productId, { status: 'processing' }));

    const idempotencyKey = crypto.randomUUID();
    const holdRes = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ productId: item.productId, quantity: item.quantity, version: item.version }),
    });
    if (holdRes.status === 401) { router.replace('/login?next=/cart/checkout'); throw new Error('Sign-in required.'); }
    const hold = await holdRes.json();
    if (!holdRes.ok) throw new Error(hold.error || 'Unable to reserve these tickets.');
    setLines((prev) => updateLine(prev, item.productId, { status: 'held' }));

    const orderRes = await fetch('/api/payments/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: hold.id }),
    });
    const order = await orderRes.json();
    if (!orderRes.ok) throw new Error(order.error || 'Unable to create a payment order.');
    setLines((prev) => updateLine(prev, item.productId, { status: 'ordered' }));

    if (order.provider === 'development') {
      const confirmRes = await fetch('/api/payments/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.orderId, bookingId: order.bookingId }),
      });
      const confirmed = await confirmRes.json();
      if (!confirmRes.ok) throw new Error(confirmed.error || 'Payment confirmation failed.');
      setLines((prev) => updateLine(prev, item.productId, { status: 'confirmed', message: hold.reference }));
    } else {
      const festivalName = locale === 'bn' ? FESTIVAL_BN : FESTIVAL;
      const paid = await openRazorpayCheckout(order, {
        name: festivalName,
        description: `${item.name} × ${item.quantity}`,
      });
      await confirmRazorpayPayment(paid);
      setLines((prev) => updateLine(prev, item.productId, { status: 'confirmed', message: hold.reference }));
    }

    cart.remove(item.productId);
  }

  async function runCheckout() {
    setRunning(true);
    setDone(false);
    let anyFailure = false;

    for (const line of lines) {
      try {
        await checkoutLine(line.item);
      } catch (error) {
        anyFailure = true;
        setLines((prev) => updateLine(prev, line.item.productId, {
          status: 'error',
          message: error instanceof Error ? error.message : 'Something went wrong.',
        }));
      }
    }

    setRunning(false);
    setDone(true);

    if (!anyFailure) {
      cart.clear();
      router.push('/tickets');
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

  const total = lines.reduce((sum, l) => sum + l.item.unitPrice * l.item.quantity, 0);

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
              {line.message && (
                <p className={line.status === 'error' ? 'banner banner--err' : 'muted'}>
                  {line.status === 'confirmed' ? t('checkout.ref', { ref: line.message }) : line.message}
                </p>
              )}
            </article>
          ))}

          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700 }}>
            <span>{t('cart.total')}</span>
            <span>{money(total, dl)}</span>
          </div>

          <button type="button" className="btn btn--primary btn--block" disabled={running} onClick={runCheckout}>
            {running ? t('checkout.processing') : t('checkout.pay', { amount: money(total, dl) })}
          </button>

          {done && lines.some((l) => l.status === 'error') && (
            <p role="alert" className="banner banner--err">{t('checkout.partialFail')}</p>
          )}
        </div>
      </section>
    </main>
  );
}
