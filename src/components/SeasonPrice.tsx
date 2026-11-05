'use client';

import { useLocale } from '@/components/LocaleProvider';
import { dateLocale } from '@/lib/i18n';
import type { SeasonPricing } from '@/lib/pricing';

/**
 * The All together price as the server computed it (pricing.ts). With a saving:
 *
 *   ₹500 × 12 programmes      (never struck through)
 *   ~~₹6,000~~                (only the original total is struck through)
 *   33.33% OFF · You save ₹2,000
 *   ₹4,000                    (what is charged)
 *
 * Without a saving (or no breakdown) only the final price is shown. Display only: the amount
 * charged is decided again on the server when the seats are held.
 */
export default function SeasonPrice({ price, pricing }: { price: number; pricing?: SeasonPricing | null }) {
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const money = (paise: number) => `₹${(paise / 100).toLocaleString(dl)}`;
  const final = pricing?.finalPrice ?? price;
  if (!pricing || !pricing.showDiscount || pricing.originalTotal === null || pricing.perProgrammePrice === null) {
    return <p className="season-price"><strong className="season-price__now" data-testid="season-final">{money(final)}</strong></p>;
  }
  const percent = pricing.discountPercent.toLocaleString(dl, { maximumFractionDigits: 2 });
  return (
    <div className="season-price">
      <p className="season-price__calc" data-testid="season-calc">
        {t('catalogue.perProgramme', { price: money(pricing.perProgrammePrice), count: pricing.programmeCount.toLocaleString(dl) })}
      </p>
      <p className="season-price__was">
        <span className="sr-only">{t('catalogue.originalPrice', { price: '' })}</span>
        <s data-testid="season-original">{money(pricing.originalTotal)}</s>
      </p>
      <p className="season-price__off" data-testid="season-discount">
        {t('catalogue.discount', { percent, amount: money(pricing.discountAmount) })}
      </p>
      <p className="season-price__final"><strong className="season-price__now" data-testid="season-final">{money(final)}</strong></p>
    </div>
  );
}
