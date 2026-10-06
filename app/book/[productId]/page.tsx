'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useCart } from '@/components/CartProvider';
import { useLocale } from '@/components/LocaleProvider';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { dateLocale, localized } from '@/lib/i18n';
import { createClientPaymentOrder, payExistingOrder, prefillFromContact, type RazorpayOrder } from '@/lib/razorpay-checkout';

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

type Coverage = { title: string; title_bn?: string; starts_at: string };
type CatalogueProduct = {
  id: string;
  name: string;
  name_bn: string;
  category: string;
  kind: string;
  price: number;
  version: number;
  coverage?: Coverage[];
};
type HoldResult = { id: string; reference: string; total: number; currency: string; expires_at: string | null; unit_price: number; quantity: number };
type OrderResult = RazorpayOrder & { provider: 'development' | 'razorpay' };

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
  const cart = useCart();
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const version = Number(searchParams.get('version') ?? 0);
  const festivalName = locale === 'bn' ? FESTIVAL_BN : FESTIVAL;

  const [quantity, setQuantity] = useState(1);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [product, setProduct] = useState<CatalogueProduct | null>(null);
  const [added, setAdded] = useState(false);
  const [stage, setStage] = useState<'select' | 'held' | 'ordered' | 'confirmed'>('select');
  const [hold, setHold] = useState<HoldResult | null>(null);
  const [order, setOrder] = useState<OrderResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [me, setMe] = useState<{ contact?: string; name?: string }>({});
  const idempotencyKey = useRef(crypto.randomUUID());
  const attemptId = useRef('');
  const resumed = useRef(false);
  const countdown = useCountdown(hold?.expires_at ?? null);

  useEffect(() => {
    fetch('/api/catalogue')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { products?: CatalogueProduct[] } | null) => {
        const match = body?.products?.find((item) => item.id === productId) ?? null;
        setProduct(match);
      })
      .catch(() => setProduct(null));
  }, [productId]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { contact?: string; name?: string };
        setMe({ contact: body.contact, name: body.name });
        if (body.name) setName((current) => current || body.name || '');
        if (body.contact) setContact((current) => current || body.contact || '');
      })
      .catch(() => undefined);
  }, []);

  const handleQuantityChange = (q: number) => {
    setQuantity(q);
    idempotencyKey.current = crypto.randomUUID();
    setError('');
  };

  const checkoutOpts = useCallback(() => ({
    name: festivalName,
    description: t('book.title'),
    ...prefillFromContact(me.contact, me.name),
    prefillEmail: me.contact?.includes('@') ? me.contact : undefined,
    prefillContact: me.contact && !me.contact.includes('@') ? me.contact : undefined,
    prefillName: me.name,
  }), [festivalName, me.contact, me.name, t]);

  const payOrder = useCallback(async (nextOrder: OrderResult) => {
    setOrder(nextOrder);
    setStage('ordered');
    setLoading(true);
    try {
      await payExistingOrder(nextOrder, checkoutOpts());
      setStage('confirmed');
    } catch (err) {
      const refund = err instanceof Error && err.message === 'REFUND_REQUIRED';
      setError(refund ? t('pay.refunded') : err instanceof Error && /cancelled/i.test(err.message) ? t('pay.cancelled') : err instanceof Error ? err.message : t('pay.failed'));
    } finally {
      setLoading(false);
    }
  }, [checkoutOpts, t]);

  const placeOrder = useCallback(async (bookingId: string) => {
    try {
      const nextOrder = await createClientPaymentOrder(bookingId);
      await payOrder(nextOrder);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pay.orderFail'));
    }
  }, [payOrder, t]);

  const placeHold = useCallback(async (who?: { name: string; contact: string; quantity: number; attemptId?: string }) => {
    const buyerName = (who?.name ?? name).trim();
    const buyerContact = (who?.contact ?? contact).trim();
    const qty = who?.quantity ?? quantity;
    setError('');
    setLoading(true);
    try {
      let nextAttempt = who?.attemptId || attemptId.current;
      if (!nextAttempt) {
        const recorded = await fetch('/api/booking-attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: buyerName, contact: buyerContact, productId, quantity: qty }),
        });
        const recordedBody = await recorded.json().catch(() => ({}));
        if (!recorded.ok) {
          setError(recordedBody.error || 'Enter your name and mobile or email.');
          return;
        }
        nextAttempt = recordedBody.id as string;
        attemptId.current = nextAttempt;
      }
      const res = await fetch('/api/holds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey.current },
        body: JSON.stringify({ productId, quantity: qty, version, attemptId: nextAttempt }),
      });
      const body = await res.json();
      if (res.status === 401) {
        sessionStorage.setItem('gb-pending-book', JSON.stringify({
          productId, quantity: qty, version, attemptId: nextAttempt, name: buyerName, contact: buyerContact,
        }));
        const next = encodeURIComponent(`/book/${productId}?version=${version}`);
        router.push(`/login?next=${next}&contact=${encodeURIComponent(buyerContact)}`);
        return;
      }
      sessionStorage.removeItem('gb-pending-book');
      if (!res.ok) { setError(body.error || 'Unable to reserve tickets. Please try again.'); return; }
      setHold(body);
      setStage('held');
      await placeOrder(body.id);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [contact, name, placeOrder, productId, quantity, router, version]);

  useEffect(() => {
    if (!me.contact || resumed.current) return;
    const raw = sessionStorage.getItem('gb-pending-book');
    if (!raw) return;
    resumed.current = true;
    try {
      const pending = JSON.parse(raw) as { productId?: string; quantity?: number; version?: number; attemptId?: string; name?: string; contact?: string };
      if (pending.productId !== productId || pending.version !== version || !pending.attemptId) return;
      sessionStorage.removeItem('gb-pending-book');
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (pending.name) setName(pending.name);
      if (pending.contact) setContact(pending.contact);
      if (pending.quantity) setQuantity(pending.quantity);
      attemptId.current = pending.attemptId;
      void placeHold({
        name: pending.name || me.name || '',
        contact: pending.contact || me.contact,
        quantity: pending.quantity || quantity,
        attemptId: pending.attemptId,
      });
    } catch {
      sessionStorage.removeItem('gb-pending-book');
    }
  }, [me.contact, me.name, placeHold, productId, quantity, version]);

  async function addToCart() {
    if (!product) {
      setError(t('catalogue.error'));
      return;
    }
    const buyerName = name.trim();
    const buyerContact = contact.trim();
    setError('');
    setLoading(true);
    try {
      const recorded = await fetch('/api/booking-attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: buyerName, contact: buyerContact, productId, quantity }),
      });
      const recordedBody = await recorded.json().catch(() => ({}));
      if (!recorded.ok) {
        setError(recordedBody.error || 'Enter your name and mobile or email.');
        return;
      }
      const show = product.coverage?.[0];
      const outcome = cart.add({
        productId: product.id,
        name: localized(product.name, product.name_bn, locale),
        category: product.category,
        kind: product.kind,
        showTitle: show ? localized(show.title, show.title_bn, locale) : '',
        startsAt: show?.starts_at || new Date().toISOString(),
        unitPrice: product.price,
        version: product.version || version,
      }, quantity);
      if (!outcome.ok) {
        setError(outcome.message || t('catalogue.addFail'));
        return;
      }
      setAdded(true);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function retryPayment() {
    if (!order) return;
    setError('');
    await payOrder(order);
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
              <label className="field" htmlFor="buyer-name">
                <span>{t('book.name')}</span>
                <input id="buyer-name" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} disabled={loading} />
              </label>
              <label className="field" htmlFor="buyer-contact">
                <span>{t('book.contact')}</span>
                <input id="buyer-contact" value={contact} autoComplete="tel" inputMode="tel" onChange={(e) => setContact(e.target.value)} disabled={loading} />
              </label>
              <label className="field" htmlFor="qty">
                <span>{t('book.qty')} <span className="muted">{t('book.max')}</span></span>
                <select id="qty" value={quantity} onChange={(e) => handleQuantityChange(Number(e.target.value))} disabled={loading}>
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              {error && <p role="alert" className="banner banner--err">{error}</p>}
              {added && <p className="banner banner--ok" role="status">{t('book.added')}</p>}
              <p className="muted">{t('book.who')}</p>
              <button type="button" className={added ? 'btn btn--ghost btn--block' : 'btn btn--primary btn--block'} disabled={loading || !product} onClick={() => { void addToCart(); }}>
                {loading ? t('book.reserving') : t('catalogue.addToCart')}
              </button>
              {added && (
                <Link href="/cart" className="btn btn--primary btn--block">{t('book.reserve')}</Link>
              )}
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

              {stage === 'ordered' && order && (
                <button type="button" className="btn btn--primary btn--block" disabled={loading || countdown === 0} onClick={retryPayment}>
                  {loading
                    ? t('book.processing')
                    : order.provider === 'razorpay'
                      ? t('book.payRazorpay', { amount: money(order.amount, dl) })
                      : t('book.payDev')}
                </button>
              )}

              {stage === 'held' && loading && (
                <p className="muted">{t('book.creatingOrder')}</p>
              )}

              {stage === 'held' && !loading && (
                <button type="button" className="btn btn--primary btn--block" disabled={countdown === 0} onClick={() => { setError(''); void placeOrder(hold.id); }}>
                  {t('book.payRazorpay', { amount: money(hold.total, dl) })}
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
