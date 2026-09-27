import { query } from '@/lib/db';
import { jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    if (!UUID.test(id)) throw new AppError(404, 'Poster not found.');
    const rows = await query<{ content_type: string; data: string }>(
      'SELECT content_type, data FROM posters WHERE id=$1',
      [id],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'Poster not found.');
    const bytes = Buffer.from(row.data, 'base64');
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': row.content_type,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
