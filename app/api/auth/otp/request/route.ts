import { requestOtp } from '@/lib/auth';
import { jsonOk, jsonError, readJson, clientIp } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson<{ contact?: string }>(request);
    const ip = clientIp(request);
    const result = await requestOtp(body.contact ?? '', ip);
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
