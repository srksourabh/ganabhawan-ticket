import { authenticated } from '@/lib/auth';
import { adminCatalogue, upsertShow, type ShowInput } from '@/lib/catalogue';
import { jsonOk, jsonError, readJson } from '@/lib/http';

const STAFF_ROLES = ['owner', 'inventory'] as const;

export async function GET(): Promise<Response> {
  try {
    await authenticated([...STAFF_ROLES]);
    const { shows } = await adminCatalogue();
    return jsonOk({ shows });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated([...STAFF_ROLES]);
    const body = await readJson<Partial<ShowInput>>(request);
    const show = await upsertShow(user, {
      title: body.title ?? '',
      titleBn: body.titleBn ?? '',
      troupe: body.troupe ?? '',
      synopsis: body.synopsis ?? '',
      synopsisBn: body.synopsisBn ?? '',
      startsAt: body.startsAt ?? '',
      runtime: Number(body.runtime ?? 0),
      genre: body.genre ?? '',
      language: body.language,
      artwork: body.artwork,
      status: body.status,
    });
    return jsonOk(show, 201);
  } catch (error) {
    return jsonError(error);
  }
}
