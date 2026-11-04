import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata, Viewport } from 'next';
import { FESTIVAL, FESTIVAL_BN, FESTIVAL_POSTER, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/brand';
import { CartProvider } from '@/components/CartProvider';
import ClerkSync from '@/components/ClerkSync';
import { LocaleProvider } from '@/components/LocaleProvider';
import SiteHeader from '@/components/SiteHeader';
import SkipLink from '@/components/SkipLink';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/noto-sans-bengali/400.css';
import '@fontsource/noto-sans-bengali/600.css';
import './globals.css';

const appUrl = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: FESTIVAL_BN,
  },
  icons: {
    // Samatat emblem (cropped from the navbar logo) for tabs, bookmarks, and link-preview favicons.
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
  },
  openGraph: {
    type: 'website',
    locale: 'bn_IN',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    siteName: FESTIVAL,
    images: [{ url: FESTIVAL_POSTER, width: 642, height: 1024, alt: FESTIVAL }],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [FESTIVAL_POSTER],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#f7f4ef',
};

const localeBootScript = `(function(){try{var k='samatat-locale';var l=localStorage.getItem(k);if(l!=='en'&&l!=='bn'){var m=document.cookie.match(/(?:^|; )samatat-locale=([^;]*)/);l=m?decodeURIComponent(m[1]):'bn'}if(l!=='en'&&l!=='bn')l='bn';document.documentElement.lang=l;document.documentElement.dataset.locale=l}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bn" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: localeBootScript }} />
      </head>
      <body>
        <ClerkProvider
          afterSignOutUrl="/"
          appearance={{
            variables: {
              colorPrimary: '#722f37',
              colorBackground: '#ffffff',
              borderRadius: '0.5rem',
            },
          }}
        >
          <LocaleProvider>
            <SkipLink />
            <CartProvider>
              <ClerkSync />
              <SiteHeader />
              <div id="main-content">{children}</div>
            </CartProvider>
          </LocaleProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
