import { NextResponse } from 'next/server';
import { catalogue } from '@/lib/catalogue';

export async function GET() {
  try {
    return NextResponse.json(await catalogue(), { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' } });
  } catch (error) {
    console.error('catalogue load failed', error);
    try {
      return NextResponse.json(await catalogue(), { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' } });
    } catch (retryError) {
      console.error('catalogue retry failed', retryError);
      return NextResponse.json({ error: 'The programme is temporarily unavailable.' }, { status: 503 });
    }
  }
}
