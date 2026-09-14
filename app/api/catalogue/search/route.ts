import { NextRequest, NextResponse } from 'next/server';
import { searchCatalogue } from '@/lib/chroma';
import { catalogue } from '@/lib/catalogue';
import type { CatalogueSearchResult } from '@/lib/chroma';

/** PostgreSQL fallback when Chroma is not configured or unreachable. */
async function searchFromCatalogue(text: string, limit: number): Promise<CatalogueSearchResult[]> {
  const q = text.trim().toLowerCase();
  const { shows, products } = await catalogue();
  const hits: CatalogueSearchResult[] = [];

  for (const show of shows) {
    const hay = [show.title, show.title_bn, show.troupe, show.genre, show.synopsis, show.synopsis_bn]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q)) continue;
    hits.push({
      id: `show:${show.id}`,
      kind: 'show',
      title: show.title,
      titleBn: show.title_bn,
      description: show.synopsis,
      score: 1,
      showId: show.id,
    });
  }

  for (const product of products) {
    const hay = [product.name, product.name_bn, product.category, product.kind].join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    hits.push({
      id: `product:${product.id}`,
      kind: 'product',
      title: product.name,
      titleBn: product.name_bn,
      description: `${product.kind} · ${product.category}`,
      score: 0.9,
      productId: product.id,
      price: product.price,
      available: product.available,
    });
  }

  return hits.slice(0, limit);
}

export async function GET(request: NextRequest) {
  const text = request.nextUrl.searchParams.get('q') || '';
  const limit = Number(request.nextUrl.searchParams.get('limit') || 8);
  if (text.trim().length < 2) return NextResponse.json({ results: [] });
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return NextResponse.json({ error: 'limit must be an integer between 1 and 20.' }, { status: 400 });
  }
  try {
    if (process.env.CHROMA_URL) {
      try {
        const results = await searchCatalogue(text, limit);
        return NextResponse.json({ results, source: 'chroma' }, { headers: { 'Cache-Control': 'private, max-age=30' } });
      } catch (error) {
        console.error('catalogue search chroma failed; falling back to postgres', error);
      }
    }
    const results = await searchFromCatalogue(text, limit);
    return NextResponse.json({ results, source: 'postgres' }, { headers: { 'Cache-Control': 'private, max-age=30' } });
  } catch (error) {
    console.error('catalogue search failed', error);
    return NextResponse.json({ error: 'Catalogue search is temporarily unavailable.' }, { status: 503 });
  }
}
