'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_VENUE, DEFAULT_VENUE_BN, FESTIVAL, FESTIVAL_BN, STAGE_PHOTOS } from '@/lib/brand';
import AuditoriumMap, { AUDITORIUM_PHOTO, type AuditoriumCategory, type AuditoriumZone } from '@/components/AuditoriumMap';
import { useCart } from '@/components/CartProvider';
import { useLocale } from '@/components/LocaleProvider';
import { dateLocale, kindLabel, localized, zoneLabel } from '@/lib/i18n';

type Show = { id: string; title: string; title_bn: string; synopsis: string; synopsis_bn: string; starts_at: string; genre: string; artwork?: string };
type Product = {
  id: string;
  name: string;
  name_bn: string;
  category: string;
  kind: 'DAILY' | 'SEASON';
  price: number;
  version: number;
  available: number;
  coverage: { id: string; title: string; starts_at: string }[];
};

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;
const ZONE_ORDER: AuditoriumCategory[] = ['Premier', 'Superior', 'Balcony'];

export default function CataloguePage() {
  const cart = useCart();
  const router = useRouter();
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const [data, setData] = useState<{ shows: Show[]; products: Product[]; festival?: { name: string; name_bn?: string; venue: string; theater_photo?: string } }>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ title: string; description: string; kind: string; showId?: string; productId?: string }[]>([]);
  const [error, setError] = useState('');
  const [selectedShowId, setSelectedShowId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load(attempt = 0) {
      try {
        const response = await fetch('/api/catalogue', { cache: 'no-store' });
        if (!response.ok) throw new Error(`catalogue ${response.status}`);
        const body = await response.json();
        if (!cancelled) {
          setData(body);
          setError('');
        }
      } catch {
        if (cancelled) return;
        if (attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
          return load(attempt + 1);
        }
        setError(t('catalogue.error'));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) return;
    const timer = setTimeout(() => {
      fetch(`/api/catalogue/search?q=${encodeURIComponent(value)}`)
        .then((response) => response.json())
        .then((body) => setResults(body.results || []))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  const shows = useMemo(() => data?.shows || [], [data]);
  const products = useMemo(() => data?.products || [], [data]);
  const seasonProducts = useMemo(() => products.filter((p) => p.kind === 'SEASON'), [products]);
  const visibleResults = query.trim().length >= 2 ? results : [];
  const venueRaw = data?.festival?.venue || DEFAULT_VENUE;
  const venue = locale === 'bn' && venueRaw === DEFAULT_VENUE ? DEFAULT_VENUE_BN : venueRaw;
  const festivalName = localized(
    data?.festival?.name || FESTIVAL,
    data?.festival?.name_bn || FESTIVAL_BN,
    locale,
  );

  const effectiveShowId = selectedShowId ?? shows[0]?.id ?? null;
  const selectedShow = shows.find((show) => show.id === effectiveShowId) ?? null;

  const zones: AuditoriumZone[] = useMemo(() => {
    if (!selectedShow) return [];
    return ZONE_ORDER.map((category) => {
      const product = products.find((p) => p.kind === 'DAILY' && p.category === category && p.coverage.some((c) => c.id === selectedShow.id));
      const season = products.find((p) => p.kind === 'SEASON' && p.category === category);
      return {
        category,
        productId: product?.id ?? null,
        price: product?.price ?? 0,
        available: product?.available ?? 0,
        seasonPrice: season?.price ?? null,
        seasonAvailable: season?.available ?? null,
      };
    });
  }, [products, selectedShow]);

  const theaterPhoto = data?.festival?.theater_photo || AUDITORIUM_PHOTO;

  function showStill(show: Show, index: number) {
    const art = show.artwork;
    if (art && (art.startsWith('/') || art.startsWith('http'))) return art;
    return STAGE_PHOTOS[index % STAGE_PHOTOS.length];
  }

  function handleAddSeason(product: Product) {
    const outcome = cart.add({
      productId: product.id,
      name: localized(product.name, product.name_bn, locale),
      category: product.category,
      kind: product.kind,
      showTitle: t('catalogue.season'),
      startsAt: shows[0]?.starts_at || new Date().toISOString(),
      unitPrice: product.price,
      version: product.version,
    });
    setNotice(
      outcome.ok
        ? t('catalogue.addedSeason', { category: zoneLabel(locale, product.category) })
        : outcome.message || t('catalogue.addFail'),
    );
  }

  function handleSelectZone(zone: AuditoriumZone) {
    if (!zone.productId || zone.available <= 0) return;
    const product = products.find((p) => p.id === zone.productId);
    if (!product) return;
    router.push(`/book/${product.id}?version=${product.version}`);
  }

  return (
    <main className="catalogue-page">
      <section className="container catalogue-page__intro">
        <p className="eyebrow">{t('catalogue.eyebrow', { venue })}</p>
        <h1>{t('catalogue.title')}</h1>
        <p className="catalogue-page__lede">
          {t('catalogue.intro', { festival: festivalName, venue })}
        </p>

        <input
          className="catalogue-page__search"
          aria-label={t('catalogue.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('catalogue.searchPlaceholder')}
        />

        {visibleResults.length > 0 && (
          <div className="stack stack--sm catalogue-page__results">
            {visibleResults.map((result) => {
              const key = `${result.kind}-${result.productId || result.showId || result.title}`;
              if (result.kind === 'show' && result.showId) {
                return (
                  <button
                    key={key}
                    type="button"
                    className="card catalogue-search-hit"
                    onClick={() => {
                      setSelectedShowId(result.showId!);
                      setQuery('');
                      setResults([]);
                    }}
                  >
                    <strong>{result.title}</strong>
                    <p className="muted">{result.description}</p>
                  </button>
                );
              }
              if (result.productId) {
                const product = products.find((p) => p.id === result.productId);
                return (
                  <article key={key} className="card catalogue-search-hit">
                    <strong>{result.title}</strong>
                    <p className="muted">{result.description}</p>
                    {product && product.available > 0 ? (
                      <Link href={`/book/${product.id}?version=${product.version}`} className="btn btn--ghost">
                        {t('catalogue.bookNow')}
                      </Link>
                    ) : null}
                  </article>
                );
              }
              return (
                <article key={key} className="card">
                  <strong>{result.title}</strong>
                  <p className="muted">{result.description}</p>
                </article>
              );
            })}
          </div>
        )}

        {query.trim().length >= 2 && visibleResults.length === 0 && (
          <p className="muted" role="status">{t('catalogue.searchEmpty')}</p>
        )}

        {error && <p role="alert" className="alert alert--error">{error}</p>}
        {!data && !error && <p role="status">{t('catalogue.loading')}</p>}
      </section>

      {shows.length > 0 && (
        <section className="container catalogue-page__shows">
          <h2>{t('catalogue.choose')}</h2>
          <div className="grid grid--tight" role="tablist" aria-label={t('catalogue.performances')}>
            {shows.map((show, index) => (
              <button
                key={show.id}
                type="button"
                role="tab"
                aria-selected={effectiveShowId === show.id}
                onClick={() => setSelectedShowId(show.id)}
                className={`card show-pick${effectiveShowId === show.id ? ' card--selected' : ''}`}
              >
                <img src={showStill(show, index)} alt="" />
                <div className="show-pick__body">
                  <p className="eyebrow">{show.genre}</p>
                  <h3>{localized(show.title, show.title_bn, locale)}</h3>
                  <time>
                    {new Date(show.starts_at).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
                  </time>
                </div>
              </button>
            ))}
          </div>

          {selectedShow && (
            <div className="card catalogue-show">
              <div className="catalogue__show-head">
                <img
                  className="catalogue__poster"
                  src={showStill(selectedShow, Math.max(0, shows.findIndex((s) => s.id === selectedShow.id)))}
                  alt=""
                />
                <div>
                  <p className="eyebrow">{selectedShow.genre} · {t('catalogue.daily')}</p>
                  <h3>{localized(selectedShow.title, selectedShow.title_bn, locale)}</h3>
                  <p className="catalogue-show__synopsis">
                    {localized(selectedShow.synopsis, selectedShow.synopsis_bn, locale)}
                  </p>
                </div>
              </div>

              <AuditoriumMap zones={zones} photoUrl={theaterPhoto} onSelectZone={handleSelectZone} />

              <p className="catalogue-show__hint">{t('catalogue.mapHint')}</p>

              {notice && (
                <p role="status" className="alert alert--info catalogue-show__notice">{notice}</p>
              )}
            </div>
          )}
        </section>
      )}

      {seasonProducts.length > 0 && (
        <section className="container catalogue-page__season">
          <h2>{t('catalogue.season')}</h2>
          <div className="grid">
            {seasonProducts.map((product) => (
              <article key={product.id} className="card catalogue-season">
                <p className="card--eyebrow">{kindLabel(locale, product.kind)} · {zoneLabel(locale, product.category)}</p>
                <h3>{localized(product.name, product.name_bn, locale)}</h3>
                <strong>{money(product.price, dl)}</strong>
                <p className="muted">
                  {t('catalogue.available', { count: product.available, shows: product.coverage?.length || 0 })}
                </p>
                {product.available > 0
                  ? (
                    <div className="stack stack--sm">
                      <Link href={`/book/${product.id}?version=${product.version}`} className="btn btn--primary btn--block">
                        {t('catalogue.bookNow')}
                      </Link>
                      <button type="button" className="btn btn--ghost btn--block" onClick={() => handleAddSeason(product)}>
                        {t('catalogue.addToCart')}
                      </button>
                    </div>
                  )
                  : <button type="button" disabled className="btn btn--brass btn--block">{t('catalogue.soldOut')}</button>}
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
