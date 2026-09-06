'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from '@/components/LocaleProvider';
import { dateLocale } from '@/lib/i18n';

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
type OrderResult = { orderId: string; provider: 'development' | 'razorpay'; amount: number; currency: string; bookingId: string };

const s = {
  page: { minHeight: '100vh', background: '#f7f2ea', padding: '2rem 1.25rem' },
  inner: { maxWidth: 520, margin: '0 auto' },
  card: { background: 'white', borderRadius: 12, padding: '2rem', boxShadow: '0 8px 32px #3d24120d' },
  eyebrow: { color: '#8b2f2f', letterSpacing: '.12em', textTransform: 'uppercase' as const, fontSize: '.78rem', margin: '0 0 .4rem' },
  heading: { fontFamily: 'Georgia, serif', fontSize: '1.8rem', margin: '0 0 1.25rem', lineHeight: 1.1 },
  label: { display: 'block', fontSize: '.9rem', fontWeight: 500, marginBottom: '.35rem', color: '#3d2a1e' },
  select: { padding: '.7rem .9rem', border: '1px solid #b9a99a', borderRadius: 6, fontSize: '1rem', background: '#fdfaf7', width: '100%', maxWidth: 160 },
  btn: { width: '100%', padding: '.9rem', background: '#8b2f2f', color: 'white', border: 0, borderRadius: 6, fontSize: '1rem', fontWeight: 600, cursor: 'pointer' },
  btnDisabled: { opacity: .5, cursor: 'not-allowed' as const },
  btnDev: { width: '100%', padding: '.9rem', background: '#2a6b3b', color: 'white', border: 0, borderRadius: 6, fontSize: '1rem', fontWeight: 600, cursor: 'pointer', marginTop: '.75rem' },
  error: { padding: '.8rem 1rem', background: '#fff0f0', border: '1px solid #e8c0c0', borderRadius: 6, color: '#8b2f2f', fontSize: '.9rem', marginTop: '.75rem' },
  info: { padding: '.8rem 1rem', background: '#fffbf0', border: '1px solid #e8d9a0', borderRadius: 6, fontSize: '.9rem', marginTop: '.75rem' },
  row: { display: 'flex', justifyContent: 'space-between', padding: '.5rem 0', borderBottom: '1px solid #f0ebe3' },
  timer: { display: 'inline-block', fontFamily: 'monospace', fontWeight: 700, color: '#8b2f2f', fontSize: '1.1rem' },
};

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

  if (stage === 'confirmed') {
    return (
      <div style={s.page}>
        <div style={s.inner}>
          <div style={{ ...s.card, textAlign: 'center' }}>
            <h1 style={{ ...s.heading, textAlign: 'center' }}>{t('book.confirmed')}</h1>
            <p style={{ color: '#64564d' }}>{t('book.ready')}</p>
            <p style={{ fontFamily: 'monospace', fontSize: '1.1rem', fontWeight: 700 }}>{hold?.reference}</p>
            <Link href="/tickets" style={{ ...s.btn, display: 'inline-block', marginTop: '1rem', textDecoration: 'none', textAlign: 'center' }}>
              {t('book.viewTickets')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <div style={s.inner}>
        <p style={{ marginBottom: '1rem' }}>
          <Link href="/catalogue" style={{ color: '#8b2f2f', textDecoration: 'none', fontSize: '.9rem' }}>{t('book.back')}</Link>
        </p>
        <div style={s.card}>
          <p style={s.eyebrow}>{t('book.eyebrow')}</p>
          <h1 style={s.heading}>{t('book.title')}</h1>

          {stage === 'select' && (
            <>
              <label htmlFor="qty" style={s.label}>{t('book.qty')} <span style={{ fontWeight: 400, color: '#64564d' }}>{t('book.max')}</span></label>
              <select id="qty" style={s.select} value={quantity} onChange={e => handleQuantityChange(Number(e.target.value))} disabled={loading}>
                {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              {error && <p role="alert" style={s.error}>{error}</p>}
              <p style={{ fontSize: '.82rem', color: '#64564d', margin: '1rem 0' }}>
                {t('book.hint')}
              </p>
              <button style={{ ...s.btn, ...(loading ? s.btnDisabled : {}) }} disabled={loading} onClick={placeHold}>
                {loading ? t('book.reserving') : t('book.reserve')}
              </button>
            </>
          )}

          {(stage === 'held' || stage === 'ordered') && hold && (
            <>
              <div style={s.row}><span>{t('book.reference')}</span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{hold.reference}</span></div>
              <div style={s.row}><span>{t('tickets.quantity')}</span><span>{hold.quantity}</span></div>
              <div style={s.row}><span>{t('tickets.unitPrice')}</span><span>{money(hold.unit_price, dl)}</span></div>
              <div style={{ ...s.row, fontWeight: 700, fontSize: '1.05rem', borderBottom: 'none' }}><span>{t('cart.total')}</span><span>{money(hold.total, dl)}</span></div>

              {countdown !== null && countdown > 0 && (
                <div style={s.info}>
                  {t('book.holdExpires')} <span style={s.timer}>{fmtSeconds(countdown)}</span>{t('book.holdComplete')}
                </div>
              )}
              {countdown === 0 && (
                <div style={s.error}>{t('book.holdExpired')} <Link href={`/book/${productId}?version=${version}`} style={{ color: '#8b2f2f' }}>{t('book.startOver')}</Link></div>
              )}

              {error && <p role="alert" style={s.error}>{error}</p>}

              {stage === 'ordered' && order?.provider === 'development' && (
                <button style={{ ...s.btnDev, ...(loading ? s.btnDisabled : {}) }} disabled={loading} onClick={confirmDevelopment}>
                  {loading ? t('book.processing') : t('book.payDev')}
                </button>
              )}

              {stage === 'ordered' && order?.provider === 'razorpay' && (
                <div style={s.info}>
                  <strong>Razorpay</strong> · <code style={{ fontFamily: 'monospace' }}>{order.orderId}</code>
                  <p style={{ margin: '.5rem 0 0' }}>{money(order.amount, dl)}</p>
                </div>
              )}

              {stage === 'held' && !error && (
                <div style={s.info}>{t('book.creatingOrder')}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
