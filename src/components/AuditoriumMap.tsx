'use client';

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

/**
 * Division overlay geometry for the hall photo (viewBox 0 0 100 56.25).
 * Photo is shot FROM the stage: stage floor at the bottom, Premier seats
 * nearest the camera, Superior under the balcony overhang, Balcony upstairs.
 */
const DIVISIONS: Record<AuditoriumCategory, { points: string; labelY: number; subY: number }> = {
  Balcony: { points: '17,23.6 21,16.5 50,15 79,16.5 83,23.6', labelY: 19, subY: 21.6 },
  Superior: { points: '11,37.1 14,29.2 86,29.2 89,37.1', labelY: 32.4, subY: 35 },
  Premier: { points: '5,48.4 9,38.2 91,38.2 95,48.4', labelY: 42.4, subY: 45.2 },
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

  function isSoldOut(zone: AuditoriumZone) {
    return !zone.productId || zone.available <= 0;
  }

  function activate(zone: AuditoriumZone) {
    if (isSoldOut(zone)) return;
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
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="dz-premier" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#7a1e28" stopOpacity="0.55" />
              <stop offset="1" stopColor="#7a1e28" stopOpacity="0.75" />
            </linearGradient>
            <linearGradient id="dz-superior" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#8f6d14" stopOpacity="0.5" />
              <stop offset="1" stopColor="#8f6d14" stopOpacity="0.7" />
            </linearGradient>
            <linearGradient id="dz-balcony" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1f3a5f" stopOpacity="0.5" />
              <stop offset="1" stopColor="#1f3a5f" stopOpacity="0.7" />
            </linearGradient>
          </defs>

          <rect className="auditorium__stage-band" x="0" y="49.5" width="100" height="6.75" />
          <text x="50" y="53.6" textAnchor="middle" className="auditorium__stage-chip">{t('map.stage')}</text>

          {zones.map((zone) => {
            const soldOut = isSoldOut(zone);
            const isSelected = zone.productId !== null && zone.productId === selectedProductId;
            const isActive = activeCategory === zone.category;
            const label = zoneLabel(locale, zone.category);
            const availability = soldOut ? t('map.soldOut') : t('map.available', { count: zone.available });
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
                aria-label={`${label}. ${zoneWhere(locale, zone.category)}. ${money(zone.price, dl)}, ${availability}`}
                className={className}
                onMouseEnter={() => setActiveCategory(zone.category)}
                onMouseLeave={() => clearActive(zone.category)}
                onFocus={() => setActiveCategory(zone.category)}
                onBlur={() => clearActive(zone.category)}
                onTouchStart={() => setActiveCategory(zone.category)}
                onClick={() => { setActiveCategory(zone.category); activate(zone); }}
                onKeyDown={(event) => handleKeyDown(event, zone)}
              >
                <polygon points={shape.points} />
                <text x="50" y={shape.labelY} textAnchor="middle" className="auditorium__division-label">
                  {label}
                </text>
                <text x="50" y={shape.subY} textAnchor="middle" className="auditorium__division-sub">
                  {soldOut ? t('map.soldOut') : `${money(zone.price, dl)} · ${zone.available}`}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

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
              {isSoldOut(activeZone)
                ? t('map.soldOut')
                : `${t('catalogue.daily')} · ${money(activeZone.price, dl)} · ${t('map.available', { count: activeZone.available })}`}
            </span>
          </>
        ) : (
          <span className="muted">{t('catalogue.mapHint')}</span>
        )}
      </div>

      <ul className="auditorium__zone-list">
        {zones.map((zone) => {
          const soldOut = isSoldOut(zone);
          const isSelected = zone.productId !== null && zone.productId === selectedProductId;
          return (
            <li key={zone.category}>
              <button
                type="button"
                className={`auditorium__zone-btn${isSelected ? ' auditorium__zone-btn--selected' : ''}`}
                disabled={soldOut}
                aria-pressed={isSelected}
                onClick={() => activate(zone)}
              >
                <strong>{zoneLabel(locale, zone.category)}</strong>
                <span>{zoneWhere(locale, zone.category)}</span>
                <span>{soldOut ? t('map.soldOut') : `${money(zone.price, dl)} · ${t('map.available', { count: zone.available })}`}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
