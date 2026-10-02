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
          <div className="home-kicker">
            <span aria-hidden="true">✨</span>
            <span>{t('home.eyebrow')}</span>
          </div>
          <h1 lang="bn">{FESTIVAL_BN}</h1>
          <p className="home-hero__en" lang="en">{FESTIVAL}</p>
          <p className="home-door__lead">{t('home.lead')}</p>

          <div className="home-door__actions">
            <Link href="/catalogue" className="btn btn--primary">
              <span>{t('home.cta')}</span>
              <span className="btn__icon" aria-hidden="true">→</span>
            </Link>
            <Link href="/catalogue" className="btn btn--ghost">
              <span>{t('nav.programme')}</span>
            </Link>
          </div>

          <p className="home-door__by">
            <span aria-hidden="true">🏛️</span>
            <span>{presented}</span>
          </p>
        </div>

        <div className="home-door__photo-wrap">
          <img className="home-door__photo" src={HERO_PHOTO} alt="Samatat Natyomela at Ganabhawan" />
        </div>
      </section>

      <section className="home-stats" aria-label={FESTIVAL_BN}>
        <div className="container home-stats__row">
          <div className="home-stat-card">
            <strong>{t('home.statSince')}</strong>
            <p>{t('home.statSinceHint')}</p>
          </div>
          <div className="home-stat-card">
            <strong>{t('home.statEditions')}</strong>
            <p>{t('home.statEditionsHint')}</p>
          </div>
          <div className="home-stat-card">
            <strong>{t('home.statShows')}</strong>
            <p>{t('home.statShowsHint')}</p>
          </div>
          <div className="home-stat-card">
            <strong>{t('home.statHome')}</strong>
            <p>{t('home.statHomeHint')}</p>
          </div>
        </div>
      </section>
    </main>
  );
}
