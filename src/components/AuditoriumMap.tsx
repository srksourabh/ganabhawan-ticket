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
 * Photo is taken FROM the stage looking at the audience.
 * Ground floor front = Premier, ground floor back under the balcony = Superior,
 * first floor = Balcony.
 */
const HOTSPOTS: Record<AuditoriumCategory, { points: string; labelY: number }> = {
  Premier: { points: '1,56 99,56 100,82 0,82', labelY: 70 },
  Superior: { points: '8,34 92,34 97,56 3,56', labelY: 46 },
  Balcony: { points: '12,5 88,5 91,34 9,34', labelY: 20 },
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
          viewBox="0 0 100 100"
          className="auditorium__overlay"
          role="group"
          aria-label={t('map.aria')}
          preserveAspectRatio="none"
        >
          <rect className="auditorium__stage-band" x="0" y="82" width="100" height="18" />
          <text x="50" y="93" textAnchor="middle" className="auditorium__stage-chip">{t('map.stage')}</text>

          {zones.map((zone) => {
            const soldOut = isSoldOut(zone);
            const isSelected = zone.productId !== null && zone.productId === selectedProductId;
            const isActive = activeCategory === zone.category;
            const label = zoneLabel(locale, zone.category);
            const availability = soldOut ? t('map.soldOut') : t('map.available', { count: zone.available });
            const className = [
              'auditorium__hotspot',
              `auditorium__hotspot--${zone.category.toLowerCase()}`,
              soldOut ? 'auditorium__hotspot--soldout' : '',
              isActive ? 'auditorium__hotspot--active' : '',
              isSelected ? 'auditorium__hotspot--selected' : '',
            ].filter(Boolean).join(' ');

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
                <polygon points={HOTSPOTS[zone.category].points} />
                <text
                  x="50"
                  y={HOTSPOTS[zone.category].labelY}
                  textAnchor="middle"
                  className="auditorium__hotspot-label"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

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
            {activeZone.seasonPrice != null && (
              <span className="auditorium__tip-line">
                {t('catalogue.season')} · {money(activeZone.seasonPrice, dl)}
                {activeZone.seasonAvailable != null ? ` · ${t('map.available', { count: activeZone.seasonAvailable })}` : ''}
              </span>
            )}
          </>
        ) : (
          <span className="muted">{t('catalogue.mapHint')}</span>
        )}
      </div>
    </div>
  );
}
