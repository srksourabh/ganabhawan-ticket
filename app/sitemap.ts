import type { MetadataRoute } from 'next';
import { appBaseUrl } from '@/lib/page-meta';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = appBaseUrl();
  const now = new Date();
  const paths = ['/', '/catalogue', '/login', '/privacy', '/terms', '/cart', '/tickets'] as const;
  return paths.map((path) => ({
    url: `${base}${path === '/' ? '' : path}`,
    lastModified: now,
    changeFrequency: path === '/' || path === '/catalogue' ? 'daily' : 'weekly',
    priority: path === '/' ? 1 : path === '/catalogue' ? 0.9 : 0.5,
  }));
}
