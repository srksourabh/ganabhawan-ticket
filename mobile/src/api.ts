const API = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000').replace(/\/$/, '');

export function mediaUrl(path: string) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return `${API}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function api<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-client', 'mobile');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export type User = { id: string; contact: string; name: string; role: string };
export type Show = {
  id: string;
  title: string;
  title_bn: string;
  starts_at: string;
  genre: string;
  artwork?: string;
};
export type Product = {
  id: string;
  name: string;
  category: string;
  kind: 'DAILY' | 'SEASON';
  price: number;
  version: number;
  available: number;
  coverage: { id: string; title: string; starts_at: string }[];
};
export type Catalogue = { shows: Show[]; products: Product[]; festival?: { name: string; venue: string; theater_photo?: string } };
