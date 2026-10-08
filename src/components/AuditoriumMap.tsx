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

type Chair = { x: number; y: number; rx: number; ry: number };
type ZoneShape = { hit: string; chairs: Chair[]; labelY: number; subY: number };

/** One row of chair marks. Ends are included; the aisle is left empty by the caller. */
function chairRow(y: number, x0: number, x1: number, count: number, rx: number, ry: number): Chair[] {
  if (count <= 1) return [{ x: (x0 + x1) / 2, y, rx, ry }];
  return Array.from({ length: count }, (_, index) => ({
    x: x0 + ((x1 - x0) * index) / (count - 1),
    y,
    rx,
    ry,
  }));
}

/** Balcony chairs follow the horseshoe: centre higher in the frame, ends lower. */
function horseshoeRow(
  yCenter: number,
  ySide: number,
  x0: number,
  x1: number,
  count: number,
  rx: number,
  ry: number,
): Chair[] {
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const x = x0 + (x1 - x0) * t;
    const u = (x - 50) / 50;
    return { x, y: yCenter + (ySide - yCenter) * u * u, rx, ry };
  });
}

function stallChairs(rows: { y: number; inset: number; n: number; rx: number; ry: number }[]): Chair[] {
  return rows.flatMap((row) => [
    ...chairRow(row.y, 8 + row.inset, 46.4, row.n, row.rx, row.ry),
    ...chairRow(row.y, 53.6, 92 - row.inset, row.n, row.rx, row.ry),
  ]);
}

/**
 * Chair marks only, on the hall photo (viewBox 0 0 100 56.25).
 * Photo is from the stage: stage at the bottom, Premier in front,
 * Superior at the back of the stalls, Balcony on the single first-floor gallery.
 * Clicks select the whole zone. Individual chairs are not seats for sale.
 */
const DIVISIONS: Record<AuditoriumCategory, ZoneShape> = {
  Balcony: {
    hit: 'M 17 25.8 Q 50 22.4 83 25.8 L 79 22.8 Q 50 21.0 21 22.8 Z',
    labelY: 28.4,
    subY: 30.4,
    chairs: [
      ...horseshoeRow(24.4, 25.6, 18, 82, 18, 0.72, 0.34),
      ...horseshoeRow(23.2, 24.4, 20, 80, 16, 0.6, 0.28),
    ],
  },
  Superior: {
    hit: 'M 16 42.4 L 22 31.4 46.6 31.4 46.6 42.4 Z M 53.4 42.4 L 53.4 31.4 78 31.4 84 42.4 Z',
    labelY: 36.6,
    subY: 38.6,
    chairs: stallChairs([
      { y: 41.6, inset: 5.4, n: 8, rx: 0.7, ry: 0.3 },
      { y: 39.8, inset: 6.4, n: 8, rx: 0.58, ry: 0.26 },
      { y: 38.1, inset: 7.4, n: 8, rx: 0.5, ry: 0.23 },
      { y: 36.5, inset: 8.3, n: 8, rx: 0.44, ry: 0.2 },
      { y: 35.0, inset: 9.2, n: 7, rx: 0.38, ry: 0.18 },
      { y: 33.6, inset: 10, n: 7, rx: 0.34, ry: 0.16 },
      { y: 32.3, inset: 10.8, n: 6, rx: 0.3, ry: 0.14 },
    ]),
  },
  Premier: {
    hit: 'M 6 50.6 L 12 42.6 46.6 42.6 46.6 50.6 Z M 53.4 50.6 L 53.4 42.6 88 42.6 94 50.6 Z',
    labelY: 46.2,
    subY: 48.4,
    chairs: stallChairs([
      { y: 49.6, inset: 0, n: 7, rx: 1.45, ry: 0.62 },
      { y: 47.8, inset: 1.2, n: 8, rx: 1.2, ry: 0.52 },
      { y: 46.2, inset: 2.4, n: 8, rx: 1.02, ry: 0.44 },
      { y: 44.8, inset: 3.5, n: 8, rx: 0.88, ry: 0.38 },
      { y: 43.5, inset: 4.5, n: 8, rx: 0.76, ry: 0.34 },
    ]),
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
          preserveAspectRatio="xMidYMid meet"
        >
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
                <path className="auditorium__hit" d={shape.hit} />
                {shape.chairs.map((chair) => (
                  <ellipse
                    key={`${zone.category}-${chair.x.toFixed(2)}-${chair.y.toFixed(2)}`}
                    className="auditorium__chair"
                    cx={chair.x}
                    cy={chair.y}
                    rx={chair.rx}
                    ry={chair.ry}
                  />
                ))}
                <text x="50" y={shape.labelY} textAnchor="middle" className="auditorium__division-label">
                  {label}
                </text>
                <text x="50" y={shape.subY} textAnchor="middle" className="auditorium__division-sub">
                  {soldOut ? t('map.soldOut') : `${money(zone.price, dl)} · ${zone.available}`}
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
                className={`auditorium__zone-btn auditorium__zone-btn--${zone.category.toLowerCase()}${isSelected ? ' auditorium__zone-btn--selected' : ''}`}
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
