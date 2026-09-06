import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { authenticated } from '@/lib/auth';
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

    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : file.type === 'image/gif' ? 'gif' : 'jpg';
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
    const dir = path.join(process.cwd(), 'public', 'uploads', 'posters');
    await mkdir(dir, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(dir, name), buffer);
    const url = `/uploads/posters/${name}`;
    return jsonOk({ url });
  } catch (error) {
    return jsonError(error);
  }
}
