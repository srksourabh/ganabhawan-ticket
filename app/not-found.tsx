'use client';

import Link from 'next/link';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { useLocale } from '@/components/LocaleProvider';

export default function NotFoundPage() {
  const { locale, t } = useLocale();
  return (
    <main className="page-pad">
      <section className="container legal-page" style={{ maxWidth: 560, textAlign: 'center' }}>
        <p className="eyebrow">{locale === 'bn' ? FESTIVAL_BN : FESTIVAL}</p>
        <h1 className="h2">{t('notFound.title')}</h1>
        <p className="muted">{t('notFound.lead')}</p>
        <div className="home-stage__actions" style={{ justifyContent: 'center' }}>
          <Link href="/" className="btn btn--primary">
            {t('notFound.home')}
          </Link>
          <Link href="/catalogue" className="btn btn--ghost">
            {t('notFound.catalogue')}
          </Link>
        </div>
      </section>
    </main>
  );
}
