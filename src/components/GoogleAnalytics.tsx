'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';
import { readCookieConsent, type CookieConsent } from '@/lib/cookie-consent';

const MEASUREMENT_ID = (process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? '').trim();

export default function GoogleAnalytics() {
  const [consent, setConsent] = useState<CookieConsent | null>(null);

  useEffect(() => {
    // Consent lives in browser storage: read after mount (same render on server and client), then follow changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConsent(readCookieConsent());
    function onConsent(event: Event) {
      const detail = (event as CustomEvent<CookieConsent>).detail;
      setConsent(detail);
    }
    window.addEventListener('samatat-cookie-consent', onConsent);
    return () => window.removeEventListener('samatat-cookie-consent', onConsent);
  }, []);

  if (!MEASUREMENT_ID || consent !== 'accepted') return null;

  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`} strategy="afterInteractive" />
      <Script id="ga4-init" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${MEASUREMENT_ID}',{anonymize_ip:true});`}
      </Script>
    </>
  );
}
