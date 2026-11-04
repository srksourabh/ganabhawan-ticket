import type { MetadataRoute } from 'next';
import { appBaseUrl } from '@/lib/page-meta';

export default function robots(): MetadataRoute.Robots {
  const base = appBaseUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/admin/', '/gate', '/gate/', '/api/', '/sso-callback'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
