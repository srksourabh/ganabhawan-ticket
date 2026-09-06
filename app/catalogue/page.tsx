'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_VENUE, DEFAULT_VENUE_BN, ORGANISATION, ORGANISATION_BN } from '@/lib/brand';
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
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const [data, setData] = useState<{ shows: Show[]; products: Product[]; festival?: { name: string; name_bn?: string; venue: string; theater_photo?: string } }>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ title: string; description: string; kind: string }[]>([]);
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
    data?.festival?.name || ORGANISATION,
    data?.festival?.name_bn || ORGANISATION_BN,
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

  function handleSelectZone(zone: AuditoriumZone) {
    if (!zone.productId || !selectedShow) return;
    const product = products.find((p) => p.id === zone.productId);
    if (!product) return;
    const showTitle = localized(selectedShow.title, selectedShow.title_bn, locale);
    const outcome = cart.add({
      productId: product.id,
      name: localized(product.name, product.name_bn, locale),
      category: product.category,
      kind: product.kind,
      showTitle,
      startsAt: selectedShow.starts_at,
      unitPrice: product.price,
      version: product.version,
    });
    setNotice(
      outcome.ok
        ? t('catalogue.added', { category: zoneLabel(locale, product.category), title: showTitle })
        : outcome.message || t('catalogue.addFail'),
    );
  }

  return (
    <main style={{ minHeight: '100vh' }}>
      <section className="container" style={{ padding: '2.5rem 0 1rem' }}>
        <p className="eyebrow">{t('catalogue.eyebrow', { venue })}</p>
        <h1 style={{ fontSize: 'clamp(2.25rem, 7vw, 5rem)', lineHeight: .95, margin: '.5rem 0 1rem' }}>{t('catalogue.title')}</h1>
        <p style={{ maxWidth: 640, fontSize: '1.1rem', lineHeight: 1.6, margin: '0 0 1.25rem' }}>
          {t('catalogue.intro', { festival: festivalName, venue })}
        </p>

        <input
          aria-label={t('catalogue.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('catalogue.searchPlaceholder')}
          style={{ maxWidth: 560, margin: '0 0 1rem' }}
        />

        {visibleResults.length > 0 && (
          <div className="stack stack--sm" style={{ maxWidth: 700, marginBottom: '2rem' }}>
            {visibleResults.map((result) => (
              <article key={`${result.kind}-${result.title}`} className="card">
                <strong>{result.title}</strong>
                <p style={{ margin: '.35rem 0 0', color: 'var(--muted)' }}>{result.description}</p>
              </article>
            ))}
          </div>
        )}

        {error && <p role="alert" className="alert alert--error">{error}</p>}
        {!data && !error && <p role="status">{t('catalogue.loading')}</p>}
      </section>

      {shows.length > 0 && (
        <section className="container" style={{ padding: '0 0 2.5rem' }}>
          <h2 style={{ fontSize: '1.6rem', margin: '0 0 1rem' }}>{t('catalogue.choose')}</h2>
          <div className="grid grid--tight" role="tablist" aria-label={t('catalogue.performances')}>
            {shows.map((show) => (
              <button
                key={show.id}
                type="button"
                role="tab"
                aria-selected={effectiveShowId === show.id}
                onClick={() => setSelectedShowId(show.id)}
                className={`card${effectiveShowId === show.id ? ' card--selected' : ''}`}
                style={{ textAlign: 'left', border: 0, cursor: 'pointer', width: '100%' }}
              >
                <p className="eyebrow" style={{ margin: 0 }}>{show.genre}</p>
                <h3 style={{ fontSize: '1.25rem', margin: '.4rem 0' }}>{localized(show.title, show.title_bn, locale)}</h3>
                <time style={{ color: 'var(--muted)', fontSize: '.88rem' }}>
                  {new Date(show.starts_at).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
                </time>
              </button>
            ))}
          </div>

          {selectedShow && (
            <div className="card" style={{ marginTop: '1.5rem' }}>
              <div className="catalogue__show-head">
                {selectedShow.artwork && (selectedShow.artwork.startsWith('/') || selectedShow.artwork.startsWith('http')) && (
                   
                  <img className="catalogue__poster" src={selectedShow.artwork} alt="" />
                )}
                <div>
                  <p className="eyebrow" style={{ margin: 0 }}>{selectedShow.genre} · {t('catalogue.daily')}</p>
                  <h3 style={{ fontSize: '1.4rem', margin: '.35rem 0 .5rem' }}>{localized(selectedShow.title, selectedShow.title_bn, locale)}</h3>
                  <p style={{ color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 1.25rem', maxWidth: 640 }}>
                    {localized(selectedShow.synopsis, selectedShow.synopsis_bn, locale)}
                  </p>
                </div>
              </div>

              <AuditoriumMap zones={zones} photoUrl={theaterPhoto} onSelectZone={handleSelectZone} />

              <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '.85rem', margin: '1rem 0 0' }}>
                {t('catalogue.mapHint')}
              </p>

              {notice && (
                <p role="status" className="alert alert--info" style={{ textAlign: 'center', marginTop: '1rem' }}>{notice}</p>
              )}
            </div>
          )}
        </section>
      )}

      {seasonProducts.length > 0 && (
        <section className="container" style={{ padding: '0 0 3.5rem' }}>
          <h2 style={{ fontSize: '1.6rem', margin: '0 0 1rem' }}>{t('catalogue.season')}</h2>
          <div className="grid">
            {seasonProducts.map((product) => (
              <article key={product.id} className="card card--dark">
                <p className="card--eyebrow">{kindLabel(locale, product.kind)} · {zoneLabel(locale, product.category)}</p>
                <h3 style={{ fontSize: '1.3rem', margin: '.4rem 0' }}>{localized(product.name, product.name_bn, locale)}</h3>
                <strong style={{ fontSize: '1.25rem' }}>{money(product.price, dl)}</strong>
                <p style={{ color: '#d8c9bd', fontSize: '.9rem' }}>
                  {t('catalogue.available', { count: product.available, shows: product.coverage?.length || 0 })}
                </p>
                {product.available > 0
                  ? <Link href={`/book/${product.id}?version=${product.version}`} className="btn btn--brass btn--block">{t('catalogue.bookNow')}</Link>
                  : <button type="button" disabled className="btn btn--brass btn--block">{t('catalogue.soldOut')}</button>}
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
