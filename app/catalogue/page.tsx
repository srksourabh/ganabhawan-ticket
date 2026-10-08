'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_VENUE, DEFAULT_VENUE_BN, FESTIVAL, FESTIVAL_BN, STAGE_PHOTOS } from '@/lib/brand';
import AuditoriumMap, { type AuditoriumCategory, type AuditoriumZone } from '@/components/AuditoriumMap';
import { useCart } from '@/components/CartProvider';
import { useLocale } from '@/components/LocaleProvider';
import { dateLocale, localized, zoneLabel, zoneWhere } from '@/lib/i18n';

type Show = { id: string; title: string; title_bn: string; troupe: string; synopsis: string; synopsis_bn: string; starts_at: string; genre: string; artwork?: string };
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
  /** Server-decided (availability.ts): only SELLABLE can be added to the cart. */
  state?: 'SELLABLE' | 'SOLD_OUT' | 'CLOSED';
};

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;
const ZONE_ORDER: AuditoriumCategory[] = ['Premier', 'Superior', 'Balcony'];

export default function CataloguePage() {
  const cart = useCart();
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const [data, setData] = useState<{ shows: Show[]; products: Product[]; festival?: { name: string; name_bn?: string; venue: string; theater_photo?: string } }>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ title: string; description: string; kind: string; showId?: string; productId?: string }[]>([]);
  const [error, setError] = useState('');
  const [selectedShowId, setSelectedShowId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [pickedZone, setPickedZone] = useState<string | null>(null);

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

  const shows = useMemo(() => [...(data?.shows || [])].sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at)), [data]);
  const products = useMemo(() => data?.products || [], [data]);
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
        available: product?.state === 'SELLABLE' ? product.available : 0,
        closed: product?.state === 'CLOSED',
        seasonPrice: season?.price ?? null,
        seasonAvailable: season?.available ?? null,
      };
    });
  }, [products, selectedShow]);

  const [now] = useState(() => Date.now());
  const dailyClosed = selectedShow ? new Date(selectedShow.starts_at).getTime() <= now : false;
  const seasonLines = ZONE_ORDER.map((category) => {
    const product = products.find((p) => p.kind === 'SEASON' && p.category === category);
    return { category, product: product ?? null };
  });

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
      // The season's own first covered performance (not the festival's first show).
      startsAt: product.coverage[0]?.starts_at || shows[0]?.starts_at || new Date().toISOString(),
      unitPrice: product.price,
      version: product.version,
    });
    setNotice(
      outcome.ok
        ? t('catalogue.addedSeason', { category: zoneLabel(locale, product.category) })
        : outcome.message || t('catalogue.addFail'),
    );
  }

  function addLine(product: Product, showTitle: string, startsAt: string, added: string) {
    const outcome = cart.add({
      productId: product.id,
      name: localized(product.name, product.name_bn, locale),
      category: product.category,
      kind: product.kind,
      showTitle,
      startsAt,
      unitPrice: product.price,
      version: product.version,
    });
    setNotice(outcome.ok ? added : outcome.message || t('catalogue.addFail'));
  }

  function handleAddDaily(zone: AuditoriumZone) {
    if (!selectedShow || !zone.productId || zone.available <= 0) return;
    const product = products.find((p) => p.id === zone.productId);
    if (!product) return;
    addLine(
      product,
      localized(selectedShow.title, selectedShow.title_bn, locale),
      selectedShow.starts_at,
      t('catalogue.added', { category: zoneLabel(locale, zone.category), title: localized(selectedShow.title, selectedShow.title_bn, locale) }),
    );
  }

  function handleAddSeasonFor(category: string) {
    const product = products.find((p) => p.kind === 'SEASON' && p.category === category);
    if (!product || product.available <= 0) return;
    handleAddSeason(product);
  }

  return (
    <main className="catalogue-page">
      <section className="container catalogue-page__intro">
        <p className="eyebrow">{t('catalogue.eyebrow', { venue })}</p>
        <h1>{t('catalogue.title')}</h1>
        <p className="catalogue-page__lede">
          {t('catalogue.intro', { festival: festivalName, venue })}
        </p>

        <div className="catalogue-page__search-wrap">
          <span className="catalogue-search-icon" aria-hidden="true">🔍</span>
          <input
            className="catalogue-page__search"
            aria-label={t('catalogue.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('catalogue.searchPlaceholder')}
          />
        </div>

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
                      <button type="button" className="btn btn--ghost" onClick={() => {
                        const show = shows.find((item) => product.coverage.some((c) => c.id === item.id));
                        addLine(
                          product,
                          product.kind === 'SEASON' ? t('catalogue.season') : localized(show?.title || product.name, show?.title_bn || product.name_bn, locale),
                          show?.starts_at || shows[0]?.starts_at || new Date().toISOString(),
                          product.kind === 'SEASON'
                            ? t('catalogue.addedSeason', { category: zoneLabel(locale, product.category) })
                            : t('catalogue.added', { category: zoneLabel(locale, product.category), title: show?.title || product.name }),
                        );
                      }}>
                        {t('catalogue.addToCart')}
                      </button>
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

      {shows.length > 0 && selectedShow && (
        <section className="container catalogue-page__shows">
          <h2>{t('catalogue.choose')}</h2>
          <div className="pick-rail" role="tablist" aria-label={t('catalogue.performances')}>
            {shows.map((show, index) => (
              <button
                key={show.id}
                type="button"
                role="tab"
                aria-selected={effectiveShowId === show.id}
                onClick={() => setSelectedShowId(show.id)}
                className={`show-rail${effectiveShowId === show.id ? ' show-rail--on' : ''}`}
              >
                <img src={showStill(show, index)} alt="" />
                <span>{localized(show.title, show.title_bn, locale)}</span>
              </button>
            ))}
          </div>

          <div className="pick">
            <img
              className="pick__poster"
              src={showStill(selectedShow, Math.max(0, shows.findIndex((s) => s.id === selectedShow.id)))}
              alt=""
            />
            <div className="pick__side">
              <p className="eyebrow">{selectedShow.genre}</p>
              <h3>{localized(selectedShow.title, selectedShow.title_bn, locale)}</h3>
              {selectedShow.troupe && <p className="pick__troupe">{selectedShow.troupe}</p>}
              <time>
                {new Date(selectedShow.starts_at).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
              </time>
              <AuditoriumMap
                zones={zones}
                selectedProductId={zones.find((zone) => zone.category === pickedZone)?.productId ?? null}
                onSelectZone={(zone) => setPickedZone(zone.category)}
              />
              <ul className="pick__zones">
                {zones.map((zone) => (
                  <li key={zone.category} className={pickedZone === zone.category ? 'pick__zone--on' : undefined}>
                    <div>
                      <strong>{zoneLabel(locale, zone.category)}</strong>
                      <p>{zoneWhere(locale, zone.category)}</p>
                      <p>
                        {t('catalogue.daily')} {money(zone.price, dl)}
                        {' · '}
                        {dailyClosed || zone.closed ? t('catalogue.closed') : zone.available > 0 ? t('map.available', { count: zone.available }) : t('map.soldOut')}
                      </p>
                    </div>
                    <div className="pick__actions">
                      <button type="button" className="btn btn--primary btn--sm" disabled={dailyClosed || zone.closed || zone.available <= 0 || !zone.productId} onClick={() => handleAddDaily(zone)}>
                        {dailyClosed || zone.closed ? t('catalogue.closed') : zone.available > 0 ? t('catalogue.addDaily') : t('catalogue.soldOut')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="muted">{t('catalogue.mapHint')}</p>
              {notice && <p role="status" className="alert alert--info">{notice}</p>}
              {cart.count > 0 && (
                <Link href="/cart" className="btn btn--primary">{t('book.reserve')}</Link>
              )}
            </div>
          </div>

          <div className="season-panel card">
            <p className="eyebrow">{t('catalogue.season')}</p>
            <h3>{t('catalogue.seasonTitle')}</h3>
            <p className="muted">{t('catalogue.seasonHint')}</p>
            <ul className="pick__zones">
              {seasonLines.map((line) => {
                // Server-decided (availability.ts): CLOSED when any covered performance can no longer be sold.
                const seasonClosed = line.product?.state === 'CLOSED';
                const available = line.product?.state === 'SELLABLE' ? line.product.available : 0;
                const closed = seasonClosed || available <= 0 || !line.product;
                return (
                  <li key={line.category}>
                    <div>
                      <strong>{zoneLabel(locale, line.category)}</strong>
                      <p>{zoneWhere(locale, line.category)}</p>
                      <p>
                        {line.product ? money(line.product.price, dl) : ''}
                        {' · '}
                        {seasonClosed ? t('catalogue.closed') : available > 0 ? t('map.available', { count: available }) : t('map.soldOut')}
                      </p>
                    </div>
                    <div className="pick__actions">
                      <button type="button" className="btn btn--ghost btn--sm" disabled={closed} onClick={() => handleAddSeasonFor(line.category)}>
                        {seasonClosed ? t('catalogue.closed') : available > 0 ? t('catalogue.addSeason') : t('catalogue.soldOut')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}
