import { requestOtp } from '@/lib/auth';
import { customerOtpEnabled, mobileFeaturesEnabled } from '@/lib/env';
import { jsonOk, jsonError, readJson, clientIp } from '@/lib/http';

/** Whether code sign-in is offered and for which contacts (display only; the server decides on POST). */
export function GET(): Response {
  return jsonOk({ codeSignIn: customerOtpEnabled(), mobile: mobileFeaturesEnabled() });
}

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
