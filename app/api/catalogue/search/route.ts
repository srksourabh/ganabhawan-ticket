import { NextRequest, NextResponse } from 'next/server';
import { searchCatalogue } from '@/lib/chroma';

export async function GET(request: NextRequest) {
  const text = request.nextUrl.searchParams.get('q') || '';
  const limit = Number(request.nextUrl.searchParams.get('limit') || 8);
  if (text.trim().length < 2) return NextResponse.json({ results: [] });
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return NextResponse.json({ error: 'limit must be an integer between 1 and 20.' }, { status: 400 });
  try {
    return NextResponse.json({ results: await searchCatalogue(text, limit) }, { headers: { 'Cache-Control': 'private, max-age=30' } });
  } catch (error) {
    console.error('catalogue search failed', error);
    return NextResponse.json({ error: 'Catalogue search is temporarily unavailable.' }, { status: 503 });
  }
}
