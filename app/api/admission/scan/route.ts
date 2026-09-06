import { authenticated } from '@/lib/auth';
import { admit } from '@/lib/admission';
import { jsonOk, jsonError, readJson } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated(['scanner', 'supervisor']);
    const body = await readJson<{
      requestId?: string;
      ticketToken?: string;
      showId?: string;
      gateId?: string;
      deviceId?: string;
    }>(request);

    const result = await admit(user, {
      requestId: body.requestId ?? '',
      ticketToken: body.ticketToken ?? '',
      showId: body.showId ?? '',
      gateId: body.gateId ?? '',
      deviceId: body.deviceId ?? '',
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
