'use client';

import { zoneStatus } from '@/lib/zone-status';
import { useState, type KeyboardEvent } from 'react';
import { useLocale } from './LocaleProvider';
import { dateLocale, zoneLabel, zoneWhere } from '@/lib/i18n';
import { AUDITORIUM_HOUSE, AUDITORIUM_PHOTO } from '@/lib/brand';

export { AUDITORIUM_PHOTO, AUDITORIUM_HOUSE };
export type AuditoriumCategory = 'Premier' | 'Superior' | 'Balcony';

export type AuditoriumZone = {
  category: AuditoriumCategory;
  productId: string | null;
  price: number;
  available: number;
  /** Server-decided: sales for this performance have closed. */
  closed?: boolean;
  seasonPrice?: number | null;
  seasonAvailable?: number | null;
};

type Props = {
  zones: AuditoriumZone[];
  photoUrl?: string;
  selectedProductId?: string | null;
  onSelectZone: (zone: AuditoriumZone) => void;
};

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

/** Hit areas match the seats in public/images/auditorium-house.svg (viewBox 0 0 680 960). */
const HITS: Record<AuditoriumCategory, { hit: string; priceY: number }> = {
  Balcony: { hit: '100,72 580,72 590,248 90,248', priceY: 178 },
  Superior: { hit: '168,308 512,308 546,488 134,488', priceY: 430 },
  Premier: { hit: '118,582 562,582 604,752 76,752', priceY: 708 },
};

function asCategory(category?: string | null): AuditoriumCategory | null {
  if (category === 'Premier' || category === 'Superior' || category === 'Balcony') return category;
  return null;
}

/** Small copy of the hall plan. Pass a zone to wash that block, as on a cart line or a receipt. */
export function AuditoriumSketch({ category }: { category?: string | null }) {
  const zone = asCategory(category);
  return (
    <figure className="auditorium__sketch">
      <img src={AUDITORIUM_HOUSE} alt="" />
      {zone && (
        <svg viewBox="0 0 680 960" className="auditorium__overlay" aria-hidden="true">
          <polygon className="auditorium__sketch-mark" points={HITS[zone].hit} />
        </svg>
      )}
    </figure>
  );
}

export default function AuditoriumMap({
  zones,
  selectedProductId,
  onSelectZone,
}: Props) {
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const [activeCategory, setActiveCategory] = useState<AuditoriumCategory | null>(null);

  /** Only an AVAILABLE zone can be chosen; closed sales are not shown as sold out (zone-status.ts). */
  function isBlocked(zone: AuditoriumZone) {
    return zoneStatus(zone) !== 'AVAILABLE';
  }

  function statusText(zone: AuditoriumZone) {
    const status = zoneStatus(zone);
    return status === 'CLOSED' ? t('map.closed') : status === 'UNAVAILABLE' ? t('map.unavailable') : t('map.soldOut');
  }

  function activate(zone: AuditoriumZone) {
    if (isBlocked(zone)) return;
    onSelectZone(zone);
  }

  function handleKeyDown(event: KeyboardEvent<SVGGElement>, zone: AuditoriumZone) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setActiveCategory(zone.category);
      activate(zone);
    }
  }

  function clearActive(category: AuditoriumCategory) {
    setActiveCategory((current) => (current === category ? null : current));
  }

  const activeZone = zones.find((zone) => zone.category === activeCategory) ?? null;

  return (
    <div className="auditorium auditorium--photo">
      <div className="auditorium__floors" aria-hidden="true">
        <span>{t('map.firstFloor')} · {zoneLabel(locale, 'Balcony')}</span>
        <span>{t('map.ground')} · {zoneLabel(locale, 'Premier')} / {zoneLabel(locale, 'Superior')}</span>
      </div>

      <div className="auditorium__frame">
        <img className="auditorium__photo" src={AUDITORIUM_HOUSE} alt="" />
        <svg
          viewBox="0 0 680 960"
          className="auditorium__overlay"
          role="group"
          aria-label={t('map.aria')}
          preserveAspectRatio="xMidYMid meet"
        >
          {zones.map((zone) => {
            const soldOut = isBlocked(zone);
            const isSelected = zone.productId !== null && zone.productId === selectedProductId;
            const isActive = activeCategory === zone.category;
            const label = zoneLabel(locale, zone.category);
            const availability = soldOut ? statusText(zone) : t('map.available', { count: zone.available });
            const priceLine = soldOut ? statusText(zone) : `${money(zone.price, dl)} · ${zone.available}`;
            const className = [
              'auditorium__division',
              `auditorium__division--${zone.category.toLowerCase()}`,
              soldOut ? 'auditorium__division--soldout' : '',
              isActive ? 'auditorium__division--active' : '',
              isSelected ? 'auditorium__division--selected' : '',
            ].filter(Boolean).join(' ');
            const shape = HITS[zone.category];

            return (
              <g
                key={zone.category}
                tabIndex={0}
                role="button"
                aria-pressed={isSelected}
                aria-disabled={soldOut}
                aria-label={`${label}. ${zoneWhere(locale, zone.category)}. ${money(zone.price, dl)}, ${availability}. ${t('map.zoneOnly')}`}
                className={className}
                onMouseEnter={() => setActiveCategory(zone.category)}
                onMouseLeave={() => clearActive(zone.category)}
                onFocus={() => setActiveCategory(zone.category)}
                onBlur={() => clearActive(zone.category)}
                onTouchStart={() => setActiveCategory(zone.category)}
                onClick={() => { setActiveCategory(zone.category); activate(zone); }}
                onKeyDown={(event) => handleKeyDown(event, zone)}
              >
                <polygon className="auditorium__hit" points={shape.hit} />
                <rect className="auditorium__price-plate" x="230" y={shape.priceY - 18} width="220" height="26" rx="5" />
                <text x="340" y={shape.priceY} textAnchor="middle" className="auditorium__price">
                  {priceLine}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <p className="auditorium__zone-only">{t('map.zoneOnly')}</p>

      <ul className="auditorium__legend" aria-hidden="true">
        {zones.map((zone) => (
          <li key={zone.category}>
            <span className={`auditorium__dot auditorium__dot--${zone.category.toLowerCase()}`} />
            {zoneLabel(locale, zone.category)}
          </li>
        ))}
      </ul>

      <div className="auditorium__tooltip auditorium__tooltip--rich" role="status" aria-live="polite">
        {activeZone ? (
          <>
            <strong>{zoneLabel(locale, activeZone.category)}</strong>
            <span className="auditorium__tip-line">{zoneWhere(locale, activeZone.category)}</span>
            <span className="auditorium__tip-line">
              {isBlocked(activeZone)
                ? statusText(activeZone)
                : `${t('catalogue.daily')} · ${money(activeZone.price, dl)} · ${t('map.available', { count: activeZone.available })}`}
            </span>
            {activeZone.seasonPrice != null && (
              <span className="auditorium__tip-line">
                {t('catalogue.season')} · {money(activeZone.seasonPrice, dl)}
              </span>
            )}
          </>
        ) : (
          <span className="muted">{t('catalogue.mapHint')}</span>
        )}
      </div>

      <ul className="auditorium__zone-list">
        {zones.map((zone) => {
          const soldOut = isBlocked(zone);
          const isSelected = zone.productId !== null && zone.productId === selectedProductId;
          return (
            <li key={zone.category}>
              <button
                type="button"
                className={`auditorium__zone-btn auditorium__zone-btn--${zone.category.toLowerCase()}${isSelected ? ' auditorium__zone-btn--selected' : ''}`}
                disabled={soldOut}
                aria-pressed={isSelected}
                onClick={() => activate(zone)}
              >
                <strong>{zoneLabel(locale, zone.category)}</strong>
                <span>{zoneWhere(locale, zone.category)}</span>
                <span>{soldOut ? statusText(zone) : `${money(zone.price, dl)} · ${t('map.available', { count: zone.available })}`}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
