'use client';

import { useLocale } from './LocaleProvider';
import type { Locale } from '@/lib/i18n';

export default function LocaleToggle() {
  const { locale, setLocale, t } = useLocale();

  function choose(next: Locale) {
    if (next === locale) return;
    setLocale(next);
  }

  return (
    <div className="locale-toggle" role="group" aria-label={t('lang.switch')}>
      <button
        type="button"
        className={`locale-toggle__btn${locale === 'en' ? ' locale-toggle__btn--active' : ''}`}
        aria-pressed={locale === 'en'}
        onClick={() => choose('en')}
      >
        EN
      </button>
      <button
        type="button"
        className={`locale-toggle__btn${locale === 'bn' ? ' locale-toggle__btn--active' : ''}`}
        lang="bn"
        aria-pressed={locale === 'bn'}
        onClick={() => choose('bn')}
      >
        বাং
      </button>
    </div>
  );
}
