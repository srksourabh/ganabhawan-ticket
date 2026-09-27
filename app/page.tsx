'use client';

import Link from 'next/link';
import { FESTIVAL, FESTIVAL_BN, HERO_PHOTO, ORGANISATION, ORGANISATION_BN } from '@/lib/brand';
import { useLocale } from '@/components/LocaleProvider';

export default function HomePage() {
  const { locale, t } = useLocale();
  const presented = locale === 'bn' ? ORGANISATION_BN : ORGANISATION;

  return (
    <main className="home-door">
      <section className="container home-door__hero">
        <div className="home-door__copy">
          <p className="home-kicker">{t('home.eyebrow')}</p>
          <h1 lang="bn">{FESTIVAL_BN}</h1>
          <p className="home-hero__en" lang="en">{FESTIVAL}</p>
          <p className="home-door__lead">{t('home.lead')}</p>
          <Link href="/catalogue" className="btn btn--primary">
            {t('home.cta')}
            <span className="btn__icon" aria-hidden="true">→</span>
          </Link>
          <p className="home-door__by">{presented}</p>
        </div>
        <img className="home-door__photo" src={HERO_PHOTO} alt="" />
      </section>

      <section className="home-stats" aria-label={FESTIVAL_BN}>
        <div className="container home-stats__row">
          <p><strong>{t('home.statSince')}</strong>{t('home.statSinceHint')}</p>
          <p><strong>{t('home.statEditions')}</strong>{t('home.statEditionsHint')}</p>
          <p><strong>{t('home.statShows')}</strong>{t('home.statShowsHint')}</p>
          <p><strong>{t('home.statHome')}</strong>{t('home.statHomeHint')}</p>
        </div>
      </section>
    </main>
  );
}
