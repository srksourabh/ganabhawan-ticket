'use client';

import { ORGANISATION_EMAIL } from '@/lib/brand';
import { useLocale } from '@/components/LocaleProvider';

export default function PrivacyPage() {
  const { t } = useLocale();
  const email = ORGANISATION_EMAIL;
  return (
    <main className="page-pad">
      <article className="container legal-page">
        <h1 className="h2">{t('privacy.title')}</h1>
        <p className="muted">{t('privacy.updated')}</p>
        <h2 className="h3">{t('privacy.s1h')}</h2>
        <p>{t('privacy.s1', { email })}</p>
        <h2 className="h3">{t('privacy.s2h')}</h2>
        <p>{t('privacy.s2')}</p>
        <h2 className="h3">{t('privacy.s3h')}</h2>
        <p>{t('privacy.s3')}</p>
        <h2 className="h3">{t('privacy.s4h')}</h2>
        <p>{t('privacy.s4')}</p>
        <h2 className="h3">{t('privacy.s5h')}</h2>
        <p>{t('privacy.s5', { email })}</p>
        <h2 className="h3">{t('privacy.s6h')}</h2>
        <p>{t('privacy.s6')}</p>
      </article>
    </main>
  );
}
