'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { readCookieConsent, writeCookieConsent, type CookieConsent } from '@/lib/cookie-consent';
import { useLocale } from './LocaleProvider';

export default function CookieBanner() {
  const { t } = useLocale();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(readCookieConsent() === null);
  }, []);

  function choose(value: CookieConsent) {
    writeCookieConsent(value);
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="cookie-banner" role="dialog" aria-labelledby="cookie-banner-title" aria-describedby="cookie-banner-body">
      <div className="cookie-banner__inner">
        <h2 id="cookie-banner-title" className="cookie-banner__title">
          {t('cookies.title')}
        </h2>
        <p id="cookie-banner-body" className="cookie-banner__body">
          {t('cookies.body')}{' '}
          <Link href="/privacy">{t('cookies.privacy')}</Link>
        </p>
        <div className="cookie-banner__actions">
          <button type="button" className="btn btn--primary" onClick={() => choose('accepted')}>
            {t('cookies.accept')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => choose('declined')}>
            {t('cookies.decline')}
          </button>
        </div>
      </div>
    </div>
  );
}
