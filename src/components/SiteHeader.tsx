'use client';

import Link from 'next/link';
import { Show, SignInButton, UserButton } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ORGANISATION, ORGANISATION_BN } from '@/lib/brand';
import { useCart } from './CartProvider';
import LocaleToggle from './LocaleToggle';
import { useLocale } from './LocaleProvider';

type MeResponse = { id: string; contact: string; name: string; role: string };

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export default function SiteHeader() {
  const pathname = usePathname();
  const { count } = useCart();
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<MeResponse | null>(null);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    function handleBeforeInstall(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: MeResponse | null) => setUser(body))
      .catch(() => setUser(null));
  }, [pathname]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }, [installPrompt]);

  const brandName = locale === 'bn' ? ORGANISATION_BN : ORGANISATION;
  const cartAria = count === 1 ? t('nav.cartBadgeOne') : t('nav.cartBadge', { count });

  return (
    <header className="site-header safe-x">
      <div className="site-header__inner">
        <Link href="/" className="site-header__brand" onClick={() => setOpen(false)} lang={locale === 'bn' ? 'bn' : undefined}>
          {brandName}
          <small>{t('nav.venue')}</small>
        </Link>

        <button
          type="button"
          className="site-header__hamburger"
          aria-label={open ? t('nav.closeMenu') : t('nav.openMenu')}
          aria-expanded={open}
          aria-controls="site-header-nav"
          onClick={() => setOpen((value) => !value)}
        >
          <span /><span /><span />
        </button>

        <nav id="site-header-nav" className={`site-header__nav${open ? ' site-header__nav--open' : ''}`}>
          <LocaleToggle />
          <Link href="/catalogue" className="site-header__link" onClick={() => setOpen(false)}>{t('nav.programme')}</Link>

          {installPrompt && (
            <button type="button" className="site-header__install" onClick={handleInstall}>
              {t('nav.install')}
            </button>
          )}

          <Link href="/cart" className="site-header__link site-header__cart" onClick={() => setOpen(false)}>
            {t('nav.cart')}
            {count > 0 && <span className="cart-badge" aria-label={cartAria}>{count}</span>}
          </Link>

          <Link href="/tickets" className="site-header__link" onClick={() => setOpen(false)}>{t('nav.tickets')}</Link>
          <Link href="/admin" className="site-header__link" onClick={() => setOpen(false)}>{t('nav.admin')}</Link>

          <Show when="signed-in">
            <span className="site-header__clerk">
              <UserButton />
            </span>
          </Show>
          <Show when="signed-out">
            {user ? (
              <span className="site-header__link" aria-label={t('nav.signedIn')}>{user.name || user.contact}</span>
            ) : (
              <>
                <SignInButton mode="modal" forceRedirectUrl={pathname || '/'}>
                  <button type="button" className="site-header__link site-header__link--pill">{t('nav.signInClerk')}</button>
                </SignInButton>
                <Link href="/login" className="site-header__link" onClick={() => setOpen(false)}>{t('nav.otp')}</Link>
              </>
            )}
          </Show>
        </nav>
      </div>
    </header>
  );
}
