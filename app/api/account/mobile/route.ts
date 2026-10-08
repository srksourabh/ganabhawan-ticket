import { authenticated } from '@/lib/auth';
import { requestMobileVerification, verifyMobile } from '@/lib/account-contacts';
import { clientIp, jsonError, jsonOk, readJson } from '@/lib/http';

/**
 * A signed-in customer adds a mobile number (required to buy). POST sends a code
 * to the number; PUT with that code stores it as the account's verified mobile.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated();
    const body = await readJson<{ mobile?: string }>(request);
    return jsonOk(await requestMobileVerification(user.id, String(body.mobile ?? ''), clientIp(request)));
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const user = await authenticated();
    const body = await readJson<{ challengeId?: string; code?: string }>(request);
    return jsonOk(await verifyMobile(user.id, String(body.challengeId ?? ''), String(body.code ?? '')));
  } catch (error) {
    return jsonError(error);
  }
}
