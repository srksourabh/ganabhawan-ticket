'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { useLocale } from '@/components/LocaleProvider';

function ThankYouBody() {
  const { locale, t } = useLocale();
  const params = useSearchParams();
  const checkoutId = params.get('checkout');

  return (
    <main className="page-pad">
      <section className="container legal-page" style={{ maxWidth: 560, textAlign: 'center' }}>
        <p className="eyebrow">{locale === 'bn' ? FESTIVAL_BN : FESTIVAL}</p>
        <h1 className="h2">{t('thankYou.title')}</h1>
        <p className="muted">{t('thankYou.lead')}</p>
        <p className="muted">{t('thankYou.ref')}</p>
        <div className="home-stage__actions" style={{ justifyContent: 'center' }}>
          {checkoutId && (
            <Link href={`/receipts/${checkoutId}`} className="btn btn--primary">
              {t('thankYou.receipt')}
            </Link>
          )}
          <Link href="/tickets" className={checkoutId ? 'btn btn--ghost' : 'btn btn--primary'}>
            {t('thankYou.tickets')}
          </Link>
          <Link href="/" className="btn btn--ghost">
            {t('thankYou.home')}
          </Link>
        </div>
      </section>
    </main>
  );
}

export default function ThankYouPage() {
  return (
    <Suspense fallback={<main className="page-pad"><p className="muted container" role="status">…</p></main>}>
      <ThankYouBody />
    </Suspense>
  );
}
