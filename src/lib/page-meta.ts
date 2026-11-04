import type { Metadata } from 'next';
import { FESTIVAL, FESTIVAL_BN, ORGANISATION, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/brand';

/** Landscape Open Graph image for link shares (1200x630). */
export const OG_SHARE = '/images/samatat/og-share.jpg';

export function appBaseUrl(): string {
  return (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

type PageMetaInput = {
  title: string;
  description: string;
  path?: string;
  image?: string;
  noIndex?: boolean;
};

/** Consistent title / description / Open Graph / Twitter for a public page. */
export function pageMetadata({
  title,
  description,
  path = '/',
  image = OG_SHARE,
  noIndex = false,
}: PageMetaInput): Metadata {
  const url = `${appBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const fullTitle = title === SITE_TITLE ? title : `${title} · ${FESTIVAL_BN}`;
  return {
    title: fullTitle,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      locale: 'bn_IN',
      url,
      title: fullTitle,
      description,
      siteName: FESTIVAL,
      images: [{ url: image, width: 1200, height: 630, alt: FESTIVAL }],
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: [image],
    },
    ...(noIndex ? { robots: { index: false, follow: false } } : {}),
  };
}

export const PAGE_META = {
  home: pageMetadata({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    path: '/',
  }),
  catalogue: pageMetadata({
    title: 'Programme',
    description: `Browse plays and ticket zones for ${FESTIVAL} at Ganabhawan, Uttarpara. Daily and all-together tickets.`,
    path: '/catalogue',
  }),
  login: pageMetadata({
    title: 'Sign in',
    description: `Sign in to buy tickets for ${FESTIVAL}. Google or one-time email code.`,
    path: '/login',
  }),
  cart: pageMetadata({
    title: 'Cart',
    description: `Your ticket cart for ${FESTIVAL}. Review zones and quantities before checkout.`,
    path: '/cart',
    noIndex: true,
  }),
  checkout: pageMetadata({
    title: 'Checkout',
    description: `Pay securely for ${FESTIVAL} tickets at Ganabhawan.`,
    path: '/cart/checkout',
    noIndex: true,
  }),
  book: pageMetadata({
    title: 'Book tickets',
    description: `Choose quantity and pay for ${FESTIVAL} tickets.`,
    path: '/book',
  }),
  tickets: pageMetadata({
    title: 'My tickets',
    description: `Your ${FESTIVAL} tickets and QR codes for gate admission.`,
    path: '/tickets',
    noIndex: true,
  }),
  thankYou: pageMetadata({
    title: 'Thank you',
    description: `Payment received for ${FESTIVAL}. View your receipt and tickets.`,
    path: '/thank-you',
    noIndex: true,
  }),
  privacy: pageMetadata({
    title: 'Privacy policy',
    description: `How ${FESTIVAL} / ${ORGANISATION} collects and uses personal data for ticketing.`,
    path: '/privacy',
  }),
  terms: pageMetadata({
    title: 'Terms of sale',
    description: `Ticket terms for ${FESTIVAL} at Ganabhawan, Uttarpara.`,
    path: '/terms',
  }),
  notFound: pageMetadata({
    title: 'Page not found',
    description: `This page is missing. Return to ${FESTIVAL} tickets.`,
    path: '/',
    noIndex: true,
  }),
} as const;
