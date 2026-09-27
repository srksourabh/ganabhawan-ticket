'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCart } from '@/components/CartProvider';
import { useLocale } from '@/components/LocaleProvider';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { dateLocale, kindLabel, zoneLabel } from '@/lib/i18n';

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

export default function CartPage() {
  const cart = useCart();
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const [notice, setNotice] = useState('');

  function changeQty(productId: string, quantity: number) {
    const result = cart.updateQty(productId, quantity);
    setNotice(result.ok ? '' : result.message || t('cart.updateFail'));
  }

  return (
    <main style={{ minHeight: '100vh' }}>
      <section className="container" style={{ padding: '2.5rem 0 3.5rem', maxWidth: 720 }}>
        <p className="eyebrow">{locale === 'bn' ? FESTIVAL_BN : FESTIVAL}</p>
        <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3rem)', margin: '0 0 .5rem' }}>{t('cart.title')}</h1>
        <p style={{ color: 'var(--muted)', margin: '0 0 1.5rem' }}>{t('cart.limitHint', { max: cart.maxTickets })}</p>

        {notice && <p role="alert" className="alert alert--error">{notice}</p>}

        {cart.items.length === 0 ? (
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ margin: '0 0 1rem' }}>{t('cart.empty')}</p>
            <Link href="/catalogue" className="btn btn--primary">{t('cart.browse')}</Link>
          </div>
        ) : (
          <div className="stack">
            {cart.items.map((item) => (
              <article key={item.productId} className="card grid--cart-line">
                <div>
                  <p className="eyebrow" style={{ margin: 0 }}>{kindLabel(locale, item.kind)} · {zoneLabel(locale, item.category)}</p>
                  <h3 style={{ fontSize: '1.1rem', margin: '.3rem 0' }}>{item.name}</h3>
                  {item.showTitle && (
                    <p style={{ color: 'var(--muted)', fontSize: '.85rem', margin: 0 }}>
                      {item.showTitle} · {new Date(item.startsAt).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
                    </p>
                  )}
                  <strong style={{ display: 'block', marginTop: '.5rem' }}>{money(item.unitPrice, dl)} {t('cart.each')}</strong>
                </div>

                <div className="stack stack--sm" style={{ alignItems: 'flex-end' }}>
                  <div className="qty-stepper">
                    <button type="button" onClick={() => changeQty(item.productId, item.quantity - 1)} aria-label={t('cart.decrease', { name: item.name })}>–</button>
                    <span aria-live="polite">{item.quantity}</span>
                    <button type="button" onClick={() => changeQty(item.productId, item.quantity + 1)} aria-label={t('cart.increase', { name: item.name })}>+</button>
                  </div>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => cart.remove(item.productId)}>{t('cart.remove')}</button>
                </div>
              </article>
            ))}

            <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700, fontSize: '1.1rem' }}>
              <span>{t('cart.total')}</span>
              <span>{money(cart.total, dl)}</span>
            </div>

            <Link href="/cart/checkout" className="btn btn--primary btn--block">{t('book.reserve')}</Link>
          </div>
        )}
      </section>
    </main>
  );
}
