'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCart } from './CartProvider';
import { useLocale } from './LocaleProvider';

const HIDDEN = [/^\/cart\/checkout/, /^\/admin/, /^\/gate/, /^\/login/, /^\/sign-in/, /^\/sign-up/, /^\/sso-callback/, /^\/thank-you/, /^\/privacy/, /^\/terms/, /^\/receipts/];

export default function StickyMobileCta() {
  const pathname = usePathname() || '/';
  const cart = useCart();
  const { t } = useLocale();

  if (HIDDEN.some((re) => re.test(pathname))) return null;
  const onBrowse = pathname === '/' || pathname.startsWith('/catalogue') || pathname.startsWith('/book');
  if (!onBrowse) return null;

  const count = cart.items.reduce((n, i) => n + i.quantity, 0);
  const href = count > 0 ? '/cart' : '/catalogue';
  const label = count > 0 ? t('sticky.cart', { count }) : t('sticky.tickets');

  return (
    <div className="sticky-cta" role="region" aria-label={label}>
      <Link href={href} className="btn btn--primary sticky-cta__btn">
        {label}
      </Link>
    </div>
  );
}
