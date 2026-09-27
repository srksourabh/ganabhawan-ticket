import { authenticated } from '@/lib/auth';
import { query } from '@/lib/db';
import { jsonOk, jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';

const MAX_BYTES = 2.5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function POST(request: Request): Promise<Response> {
  try {
    await authenticated(['owner', 'inventory']);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new AppError(400, 'Choose an image file to upload.');
    if (!ALLOWED.has(file.type)) throw new AppError(400, 'Use a JPEG, PNG, WebP, or GIF image.');
    if (file.size <= 0 || file.size > MAX_BYTES) throw new AppError(400, 'Image must be under 2.5 MB.');

    const bytes = Buffer.from(await file.arrayBuffer());
    const rows = await query<{ id: string }>(
      'INSERT INTO posters(content_type, data) VALUES($1, $2) RETURNING id',
      [file.type, bytes.toString('base64')],
    );
    const id = rows[0]?.id;
    if (!id) throw new AppError(500, 'Poster could not be stored.');
    return jsonOk({ url: `/api/posters/${id}` });
  } catch (error) {
    return jsonError(error);
  }
}
