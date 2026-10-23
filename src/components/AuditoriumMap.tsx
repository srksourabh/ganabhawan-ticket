'use client';

import { zoneStatus } from '@/lib/zone-status';
import { useState, type KeyboardEvent } from 'react';
import { useLocale } from './LocaleProvider';
import { dateLocale, zoneLabel, zoneWhere } from '@/lib/i18n';
import { AUDITORIUM_PHOTO } from '@/lib/brand';

export { AUDITORIUM_PHOTO };
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

type ZoneShape = { hit: string; labelY: number; subY: number };

/**
 * Filled zones on the hall photo (viewBox 0 0 100 56.25).
 * The photo looks out from the stage, so the stage sits at the bottom.
 * Premier is the front stalls, Superior the rear stalls, Balcony the gallery.
 * A click selects the whole zone. Chairs are not sold one by one.
 * Each zone is one full-width band so the name sits on the color.
 */
const ZONE_FILL: Record<AuditoriumCategory, string> = {
  Balcony: '#2468c4',
  Superior: '#e2ac22',
  Premier: '#d1263a',
};

const DIVISIONS: Record<AuditoriumCategory, ZoneShape> = {
  Balcony: {
    hit: 'M 5 2.6 H 95 V 16.2 H 5 Z',
    labelY: 8.2,
    subY: 12.2,
  },
  Superior: {
    hit: 'M 5 17.6 H 95 V 32.4 H 5 Z',
    labelY: 23.4,
    subY: 27.6,
  },
  Premier: {
    hit: 'M 5 33.8 H 95 V 48.6 H 5 Z',
    labelY: 39.6,
    subY: 43.8,
  },
};

export default function AuditoriumMap({
  zones,
  photoUrl = AUDITORIUM_PHOTO,
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
        <img className="auditorium__photo" src={photoUrl} alt="" />
        <svg
          viewBox="0 0 100 56.25"
          className="auditorium__overlay"
          role="group"
          aria-label={t('map.aria')}
          preserveAspectRatio="xMidYMid meet"
        >
          <rect className="auditorium__scrim" x="0" y="0" width="100" height="56.25" pointerEvents="none" />
          {zones.map((zone) => {
            const soldOut = isBlocked(zone);
            const isSelected = zone.productId !== null && zone.productId === selectedProductId;
            const isActive = activeCategory === zone.category;
            const label = zoneLabel(locale, zone.category);
            const availability = soldOut ? statusText(zone) : t('map.available', { count: zone.available });
            const className = [
              'auditorium__division',
              `auditorium__division--${zone.category.toLowerCase()}`,
              soldOut ? 'auditorium__division--soldout' : '',
              isActive ? 'auditorium__division--active' : '',
              isSelected ? 'auditorium__division--selected' : '',
            ].filter(Boolean).join(' ');
            const shape = DIVISIONS[zone.category];

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
                <path className="auditorium__hit" d={shape.hit} fill={soldOut ? '#6e675f' : ZONE_FILL[zone.category]} />
                <text x="50" y={shape.labelY} textAnchor="middle" className="auditorium__division-label">
                  {label}
                </text>
                <text x="50" y={shape.subY} textAnchor="middle" className="auditorium__division-sub">
                  {soldOut ? statusText(zone) : `${money(zone.price, dl)} · ${zone.available}`}
                </text>
              </g>
            );
          })}

          <rect className="auditorium__stage-band" x="0" y="51.8" width="100" height="4.45" />
          <text x="50" y="54.6" textAnchor="middle" className="auditorium__stage-chip">{t('map.stage')}</text>
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
