'use client';

import Link from 'next/link';
import {
  FESTIVAL,
  FESTIVAL_BN,
  FESTIVAL_POSTER,
  GANABHAWAN_GATE_POSTER,
  ORGANISATION,
  ORGANISATION_BN,
} from '@/lib/brand';
import { useLocale } from '@/components/LocaleProvider';

export default function HomePage() {
  const { locale, t } = useLocale();
  const presented = locale === 'bn' ? ORGANISATION_BN : ORGANISATION;
  const brand = locale === 'bn' ? FESTIVAL_BN : FESTIVAL;
  const brandAlt = locale === 'bn' ? FESTIVAL : FESTIVAL_BN;

  return (
    <main className="home-door">
      <section className="home-stage" aria-label={brand}>
        <div className="home-stage__posters" aria-hidden="false">
          <figure className="home-stage__poster home-stage__poster--festival">
            <img
              src={FESTIVAL_POSTER}
              alt={locale === 'bn' ? 'সমতট নাট্যমেলা ২০২৬ — মূল পোস্টার' : 'Samatat Natyomela 2026 — festival poster'}
              width={642}
              height={1024}
              decoding="async"
              fetchPriority="high"
            />
          </figure>
          <figure className="home-stage__poster home-stage__poster--gate">
            <img
              src={GANABHAWAN_GATE_POSTER}
              alt={
                locale === 'bn'
                  ? 'গণভবনের ফটক — নাট্যশিল্পীদের ছবি সহ উৎসব পোস্টার'
                  : 'Ganabhawan gate — festival poster with theatre artists on the facade'
              }
              width={1500}
              height={1125}
              decoding="async"
              fetchPriority="high"
            />
          </figure>
        </div>

        <div className="home-stage__veil" aria-hidden="true" />

        <div className="container home-stage__copy">
          <p className="home-stage__eyebrow">{t('home.eyebrow')}</p>
          <h1 lang={locale === 'bn' ? 'bn' : 'en'}>{brand}</h1>
          <p className="home-stage__alt" lang={locale === 'bn' ? 'en' : 'bn'}>
            {brandAlt}
          </p>
          <p className="home-stage__lead">{t('home.lead')}</p>
          <div className="home-stage__actions">
            <Link href="/catalogue" className="btn btn--primary">
              <span>{t('home.cta')}</span>
              <span className="btn__icon" aria-hidden="true">
                →
              </span>
            </Link>
            <Link href="/catalogue" className="btn btn--ghost home-stage__ghost">
              <span>{t('nav.programme')}</span>
            </Link>
          </div>
          <p className="home-stage__by">{presented}</p>
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
