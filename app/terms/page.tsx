'use client';

import { ORGANISATION_EMAIL } from '@/lib/brand';
import { useLocale } from '@/components/LocaleProvider';

export default function TermsPage() {
  const { t } = useLocale();
  const email = ORGANISATION_EMAIL;
  return (
    <main className="page-pad">
      <article className="container legal-page">
        <h1 className="h2">{t('terms.pageTitle')}</h1>
        <p className="muted">{t('terms.updated')}</p>
        <h2 className="h3">{t('terms.s1h')}</h2>
        <p>{t('terms.s1')}</p>
        <h2 className="h3">{t('terms.s2h')}</h2>
        <p>{t('terms.s2')}</p>
        <h2 className="h3">{t('terms.s3h')}</h2>
        <p>{t('terms.s3')}</p>
        <h2 className="h3">{t('terms.s4h')}</h2>
        <p>{t('terms.s4')}</p>
        <h2 className="h3">{t('terms.s5h')}</h2>
        <p>{t('terms.s5', { email })}</p>
      </article>
    </main>
  );
}
