'use client';

import type { KeyboardEvent } from 'react';
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

/** Schematic geometry: stage band at the bottom, Premier nearest the stage. */
const SHAPES: Record<AuditoriumCategory, { x: number; y: number; w: number; h: number }> = {
  Balcony: { x: 14, y: 4, w: 72, h: 26 },
  Superior: { x: 8, y: 34, w: 84, h: 22 },
  Premier: { x: 2, y: 60, w: 96, h: 22 },
};

export default function AuditoriumMap({
  zones,
  selectedProductId,
  onSelectZone,
}: Props) {
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);

  function isSoldOut(zone: AuditoriumZone) {
    return !zone.productId || zone.available <= 0;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, zone: AuditoriumZone) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!isSoldOut(zone)) onSelectZone(zone);
    }
  }

  return (
    <div className="auditorium auditorium--schematic">
      <div className="auditorium__floors" aria-hidden="true">
        <span>{t('map.firstFloor')} · {zoneLabel(locale, 'Balcony')}</span>
        <span>{t('map.ground')} · {zoneLabel(locale, 'Premier')} / {zoneLabel(locale, 'Superior')}</span>
      </div>

      <svg viewBox="0 0 100 100" className="auditorium__schem" role="img" aria-label={t('map.aria')} preserveAspectRatio="xMidYMid meet">
        {zones.map((zone) => {
          const soldOut = isSoldOut(zone);
          const isSelected = zone.productId !== null && zone.productId === selectedProductId;
          const shape = SHAPES[zone.category];
          return (
            <g key={zone.category} aria-hidden="true">
              <rect
                x={shape.x}
                y={shape.y}
                width={shape.w}
                height={shape.h}
                rx={2.5}
                className={`auditorium__schem-zone auditorium__schem-zone--${zone.category.toLowerCase()}${soldOut ? ' auditorium__schem-zone--soldout' : ''}${isSelected ? ' auditorium__schem-zone--selected' : ''}`}
              />
              <text x={shape.x + shape.w / 2} y={shape.y + shape.h / 2 - 1} textAnchor="middle" className="auditorium__schem-label">
                {zoneLabel(locale, zone.category)}
              </text>
              <text x={shape.x + shape.w / 2} y={shape.y + shape.h / 2 + 5} textAnchor="middle" className="auditorium__schem-sub">
                {soldOut ? t('map.soldOut') : `${money(zone.price, dl)} · ${zone.available}`}
              </text>
            </g>
          );
        })}
        <rect x={0} y={86} width={100} height={14} rx={2} className="auditorium__schem-stage" />
        <text x={50} y={94.5} textAnchor="middle" className="auditorium__schem-stage-label">{t('map.stage')}</text>
      </svg>

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
                aria-label={t('map.zoneAria', {
                  category: zoneLabel(locale, zone.category),
                  price: money(zone.price, dl),
                  availability: soldOut ? t('map.soldOut') : t('map.available', { count: zone.available }),
                })}
                onClick={() => onSelectZone(zone)}
                onKeyDown={(event) => handleKeyDown(event, zone)}
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
