'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from '@/components/LocaleProvider';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { dateLocale } from '@/lib/i18n';
import { confirmRazorpayPayment, openRazorpayCheckout } from '@/lib/razorpay-checkout';

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

function useCountdown(expiresAt: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

type HoldResult = { id: string; reference: string; total: number; currency: string; expires_at: string | null; unit_price: number; quantity: number };
type OrderResult = { orderId: string; provider: 'development' | 'razorpay'; amount: number; currency: string; keyId: string; bookingId: string };

function fmtSeconds(value: number) {
  const m = Math.floor(value / 60);
  return `${m}:${String(value % 60).padStart(2, '0')}`;
}

export default function BookPage() {
  return (
    <Suspense fallback={<BookFallback />}>
      <BookPageInner />
    </Suspense>
  );
}

function BookFallback() {
  const { t } = useLocale();
  return <main className="page-pad"><p className="muted">{t('book.loading')}</p></main>;
}

function BookPageInner() {
  const { productId } = useParams<{ productId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const version = Number(searchParams.get('version') ?? 0);
  const festivalName = locale === 'bn' ? FESTIVAL_BN : FESTIVAL;

  const [quantity, setQuantity] = useState(1);
  const [stage, setStage] = useState<'select' | 'held' | 'ordered' | 'confirmed'>('select');
  const [hold, setHold] = useState<HoldResult | null>(null);
  const [order, setOrder] = useState<OrderResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const idempotencyKey = useRef(crypto.randomUUID());
  const countdown = useCountdown(hold?.expires_at ?? null);

  const handleQuantityChange = (q: number) => {
    setQuantity(q);
    idempotencyKey.current = crypto.randomUUID();
    setError('');
  };

  const placeOrder = useCallback(async (bookingId: string) => {
    try {
      const res = await fetch('/api/payments/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || 'Unable to create payment order.'); return; }
      setOrder(body);
      setStage('ordered');
    } catch {
      setError('Unable to create payment order. Your hold is active — please refresh.');
    }
  }, []);

  const placeHold = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/holds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey.current },
        body: JSON.stringify({ productId, quantity, version }),
      });
      const body = await res.json();
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/book/${productId}?version=${version}`)}`);
        return;
      }
      if (!res.ok) { setError(body.error || 'Unable to reserve tickets. Please try again.'); return; }
      setHold(body);
      setStage('held');
      await placeOrder(body.id);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [productId, quantity, version, router, placeOrder]);

  async function confirmDevelopment() {
    if (!order) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/payments/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.orderId, bookingId: order.bookingId }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || 'Payment confirmation failed.'); return; }
      setStage('confirmed');
    } catch {
      setError('Network error during confirmation.');
    } finally {
      setLoading(false);
    }
  }

  async function payWithRazorpay() {
    if (!order || order.provider !== 'razorpay') return;
    setError('');
    setLoading(true);
    try {
      const paid = await openRazorpayCheckout(order, {
        name: festivalName,
        description: t('book.title'),
      });
      await confirmRazorpayPayment(paid);
      setStage('confirmed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed.');
    } finally {
      setLoading(false);
    }
  }

  if (stage === 'confirmed') {
    return (
      <main className="page-pad">
        <section className="container" style={{ maxWidth: 520 }}>
          <div className="card stack" style={{ textAlign: 'center' }}>
            <h1 className="h2">{t('book.confirmed')}</h1>
            <p className="muted">{t('book.ready')}</p>
            <p style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{hold?.reference}</p>
            <Link href="/tickets" className="btn btn--primary">{t('book.viewTickets')}</Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-pad">
      <section className="container" style={{ maxWidth: 520 }}>
        <p style={{ marginBottom: '1rem' }}>
          <Link href="/catalogue" className="muted">{t('book.back')}</Link>
        </p>
        <div className="card stack">
          <p className="eyebrow">{t('book.eyebrow')}</p>
          <h1 className="h2">{t('book.title')}</h1>

          {stage === 'select' && (
            <>
              <label className="field" htmlFor="qty">
                <span>{t('book.qty')} <span className="muted">{t('book.max')}</span></span>
                <select id="qty" value={quantity} onChange={(e) => handleQuantityChange(Number(e.target.value))} disabled={loading}>
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              {error && <p role="alert" className="banner banner--err">{error}</p>}
              <p className="muted">{t('book.hint')}</p>
              <button type="button" className="btn btn--primary btn--block" disabled={loading} onClick={placeHold}>
                {loading ? t('book.reserving') : t('book.reserve')}
              </button>
            </>
          )}

          {(stage === 'held' || stage === 'ordered') && hold && (
            <>
              <div className="stack stack--sm">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{t('book.reference')}</span><strong style={{ fontFamily: 'ui-monospace, monospace' }}>{hold.reference}</strong></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{t('tickets.quantity')}</span><span>{hold.quantity}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{t('tickets.unitPrice')}</span><span>{money(hold.unit_price, dl)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>{t('cart.total')}</span><span>{money(hold.total, dl)}</span></div>
              </div>

              {countdown !== null && countdown > 0 && (
                <p className="banner banner--ok" role="status">
                  {t('book.holdExpires')} <strong>{fmtSeconds(countdown)}</strong>{t('book.holdComplete')}
                </p>
              )}
              {countdown === 0 && (
                <p className="banner banner--err">
                  {t('book.holdExpired')} <Link href={`/book/${productId}?version=${version}`}>{t('book.startOver')}</Link>
                </p>
              )}

              {error && <p role="alert" className="banner banner--err">{error}</p>}

              {stage === 'ordered' && order?.provider === 'development' && (
                <button type="button" className="btn btn--primary btn--block" disabled={loading} onClick={confirmDevelopment}>
                  {loading ? t('book.processing') : t('book.payDev')}
                </button>
              )}

              {stage === 'ordered' && order?.provider === 'razorpay' && (
                <button type="button" className="btn btn--primary btn--block" disabled={loading} onClick={payWithRazorpay}>
                  {loading ? t('book.processing') : t('book.payRazorpay', { amount: money(order.amount, dl) })}
                </button>
              )}

              {stage === 'held' && !error && (
                <p className="muted">{t('book.creatingOrder')}</p>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
