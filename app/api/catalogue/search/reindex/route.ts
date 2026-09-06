import { NextRequest, NextResponse } from 'next/server';
import { catalogue } from '@/lib/catalogue';
import { indexCatalogue } from '@/lib/chroma';
import { hash, safeEqual } from '@/lib/security';

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!expected || !provided || !safeEqual(hash(provided), hash(expected))) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const current = await catalogue();
    return NextResponse.json(await indexCatalogue(current.shows, current.products));
  } catch (error) {
    console.error('catalogue reindex failed', error);
    return NextResponse.json({ error: 'Catalogue reindex failed.' }, { status: 503 });
  }
}
