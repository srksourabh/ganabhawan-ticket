'use client';

import Link from 'next/link';
import { Show, SignInButton, UserButton, useClerk } from '@clerk/nextjs';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { BRAND_LOGO, FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
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
  const router = useRouter();
  const clerk = useClerk();
  const { count, signedOut } = useCart();
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

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    if (clerk.session) await clerk.signOut().catch(() => undefined);
    // This account's cart leaves the browser; whoever signs in next starts with their own.
    signedOut();
    setUser(null);
    setOpen(false);
    router.refresh();
  }

  const brandName = locale === 'bn' ? FESTIVAL_BN : FESTIVAL;
  const cartAria = count === 1 ? t('nav.cartBadgeOne') : t('nav.cartBadge', { count });

  return (
    <header className="site-header safe-x">
      <div className="site-header__inner">
        <Link href="/" className="site-header__brand" onClick={() => setOpen(false)} lang={locale === 'bn' ? 'bn' : undefined}>
          <img src={BRAND_LOGO} alt="" className="site-header__logo" width={36} height={36} />
          <span className="site-header__brand-text">
            {brandName}
            <small>{t('nav.venue')}</small>
          </span>
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
          {user && user.role !== 'customer' && (
            <Link href="/gate" className="site-header__link" onClick={() => setOpen(false)}>{t('nav.gate')}</Link>
          )}
          {user && user.role !== 'customer' && (
            <Link href="/admin" className="site-header__link" onClick={() => setOpen(false)}>{t('nav.admin')}</Link>
          )}

          <Show when="signed-in">
            <span className="site-header__clerk">
              <UserButton />
            </span>
          </Show>
          {user && (
            <button type="button" className="site-header__link" onClick={() => { void signOut(); }}>
              {t('nav.signOut')}
            </button>
          )}
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

      {/* Mobile Bottom Dock for Instant Navigation */}
      <nav className="mobile-bottom-dock" aria-label="Mobile Navigation">
        <Link href="/" className={`mobile-dock__link${pathname === '/' ? ' mobile-dock__link--active' : ''}`}>
          <span className="mobile-dock__icon" aria-hidden="true">🏛️</span>
          <span>{locale === 'bn' ? 'উৎসব' : 'Home'}</span>
        </Link>
        <Link href="/catalogue" className={`mobile-dock__link${pathname.startsWith('/catalogue') ? ' mobile-dock__link--active' : ''}`}>
          <span className="mobile-dock__icon" aria-hidden="true">🎭</span>
          <span>{t('nav.programme')}</span>
        </Link>
        <Link href="/cart" className={`mobile-dock__link${pathname.startsWith('/cart') ? ' mobile-dock__link--active' : ''}`}>
          <span className="mobile-dock__icon" aria-hidden="true">🛒</span>
          <span>{t('nav.cart')}</span>
          {count > 0 && <span className="mobile-dock__badge">{count}</span>}
        </Link>
        <Link href="/tickets" className={`mobile-dock__link${pathname.startsWith('/tickets') ? ' mobile-dock__link--active' : ''}`}>
          <span className="mobile-dock__icon" aria-hidden="true">🎫</span>
          <span>{t('nav.tickets')}</span>
        </Link>
        {user && user.role !== 'customer' && (
          <Link href="/gate" className={`mobile-dock__link${pathname.startsWith('/gate') ? ' mobile-dock__link--active' : ''}`}>
            <span className="mobile-dock__icon" aria-hidden="true">🚪</span>
            <span>{t('nav.gate')}</span>
          </Link>
        )}
        {user && user.role !== 'customer' && (
          <Link href="/admin" className={`mobile-dock__link${pathname.startsWith('/admin') ? ' mobile-dock__link--active' : ''}`}>
            <span className="mobile-dock__icon" aria-hidden="true">⚙️</span>
            <span>{t('nav.admin')}</span>
          </Link>
        )}
      </nav>
    </header>
  );
}
