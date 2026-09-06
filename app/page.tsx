'use client';

import Link from 'next/link';
import { ORGANISATION, ORGANISATION_BN } from '@/lib/brand';
import { useLocale } from '@/components/LocaleProvider';

export default function HomePage() {
  const { locale, t } = useLocale();
  const brand = locale === 'bn' ? ORGANISATION_BN : ORGANISATION;
  const secondary = locale === 'bn' ? ORGANISATION : ORGANISATION_BN;

  return (
    <main className="hero safe-bottom">
      <div className="container">
        <div className="stack" style={{ maxWidth: 720 }}>
          <p className="eyebrow">{t('home.eyebrow')}</p>
          <h1 lang={locale === 'bn' ? 'bn' : undefined} style={{ fontSize: 'clamp(2.5rem, 9vw, 5rem)', lineHeight: 0.98 }}>
            {brand}
          </h1>
          <p lang={locale === 'bn' ? 'en' : 'bn'} style={{ color: 'var(--muted)', margin: 0, fontSize: '1.1rem' }}>{secondary}</p>
          <p style={{ fontSize: '1.15rem', lineHeight: 1.6, margin: 0 }}>
            {t('home.lead')}
          </p>
          <p style={{ color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
            {t('home.support')}
          </p>
          <div>
            <Link href="/catalogue" className="btn btn--primary">
              {t('home.cta')}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
