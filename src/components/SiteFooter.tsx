'use client';

import Link from 'next/link';
import { ORGANISATION_EMAIL } from '@/lib/brand';
import { useLocale } from './LocaleProvider';

export default function SiteFooter() {
  const { t } = useLocale();
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <nav className="site-footer__nav" aria-label="Legal">
          <Link href="/catalogue">{t('footer.programme')}</Link>
          <Link href="/privacy">{t('footer.privacy')}</Link>
          <Link href="/terms">{t('footer.terms')}</Link>
          <a href={`mailto:${ORGANISATION_EMAIL}`}>{t('footer.support')}</a>
        </nav>
        <p className="site-footer__copy">{t('footer.rights')}</p>
      </div>
    </footer>
  );
}
