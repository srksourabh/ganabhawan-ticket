export const COOKIE_CONSENT_KEY = 'samatat-cookie-consent';

export type CookieConsent = 'accepted' | 'declined';

export function readCookieConsent(): CookieConsent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(COOKIE_CONSENT_KEY);
    if (raw === 'accepted' || raw === 'declined') return raw;
  } catch {
    // ignore
  }
  return null;
}

export function writeCookieConsent(value: CookieConsent) {
  try {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, value);
    document.cookie = `${COOKIE_CONSENT_KEY}=${value};path=/;max-age=31536000;samesite=lax`;
    window.dispatchEvent(new CustomEvent('samatat-cookie-consent', { detail: value }));
  } catch {
    // ignore
  }
}
