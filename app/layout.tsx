import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata, Viewport } from 'next';
import { FESTIVAL_BN, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/brand';
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

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: FESTIVAL_BN,
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
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
