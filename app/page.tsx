'use client';

import Link from 'next/link';
import {
  BRAND_LOGO,
  FESTIVAL,
  FESTIVAL_BN,
  HERO_PHOTO,
  ORGANISATION,
  ORGANISATION_BN,
  SOURCE_SITE,
  STAGE_PHOTOS,
  STORY_PHOTO,
} from '@/lib/brand';
import { useLocale } from '@/components/LocaleProvider';

const STRIP = STAGE_PHOTOS.slice(0, 6);

export default function HomePage() {
  const { locale, t } = useLocale();
  const presented = locale === 'bn' ? ORGANISATION_BN : ORGANISATION;

  return (
    <main className="home">
      <section className="home-hero">
        <div className="home-hero__stage" aria-hidden="true">
          <img className="home-hero__feature" src={HERO_PHOTO} alt="" />
          <div className="home-hero__strip">
            {STRIP.map((src) => (
              <img key={src} src={src} alt="" />
            ))}
          </div>
        </div>
        <div className="home-hero__scrim" aria-hidden="true" />
        <div className="container home-hero__copy">
          <p className="home-kicker">{t('home.eyebrow')}</p>
          <h1 lang="bn">{FESTIVAL_BN}</h1>
          <p className="home-hero__en" lang="en">{FESTIVAL}</p>
          <span className="home-rule" aria-hidden="true" />
          <p className="home-hero__lead">{t('home.lead')}</p>
          <div className="home-hero__actions">
            <Link href="/catalogue" className="btn btn--primary">
              {t('home.cta')}
              <span className="btn__icon" aria-hidden="true">→</span>
            </Link>
            <a className="btn btn--ghost" href={SOURCE_SITE} rel="noreferrer">
              {t('home.source')}
            </a>
          </div>
        </div>
      </section>

      <section className="home-stats" aria-label={FESTIVAL_BN}>
        <div className="container home-stats__row">
          <p><strong>{t('home.statSince')}</strong>{t('home.statSinceHint')}</p>
          <p><strong>{t('home.statEditions')}</strong>{t('home.statEditionsHint')}</p>
          <p><strong>{t('home.statShows')}</strong>{t('home.statShowsHint')}</p>
          <p><strong>{t('home.statHome')}</strong>{t('home.statHomeHint')}</p>
        </div>
      </section>

      <section className="home-story">
        <div className="container home-story__grid">
          <figure className="home-story__photo">
            <img src={STORY_PHOTO} alt="" />
          </figure>
          <div className="home-story__text">
            <h2>{t('home.storyTitle')}</h2>
            <p>{t('home.story')}</p>
            <p className="muted">{t('home.support')}</p>
            <p className="home-presented">
              <img src={BRAND_LOGO} alt="" width={36} height={36} />
              <span>{presented}</span>
            </p>
          </div>
        </div>
      </section>

      <section className="home-split">
        <div className="container home-split__grid">
          <article>
            <h2>{t('home.melaTitle')}</h2>
            <p>{t('home.mela')}</p>
          </article>
          <article>
            <h2>{t('home.heritageTitle')}</h2>
            <p>{t('home.heritage')}</p>
          </article>
        </div>
      </section>

      <section className="home-close">
        <div className="container">
          <h2 lang="bn">{FESTIVAL_BN}</h2>
          <p className="muted">{presented}</p>
        </div>
      </section>
    </main>
  );
}
