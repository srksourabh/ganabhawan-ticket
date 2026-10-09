import { authenticated } from '@/lib/auth';
import { verifiedContacts } from '@/lib/account-contacts';
import { mobileFeaturesEnabled } from '@/lib/env';
import { jsonOk, jsonError } from '@/lib/http';

export async function GET(): Promise<Response> {
  try {
    const user = await authenticated();
    // Verified contacts only. mobileEnabled is the server's MOBILE_PHONE_NUMBER_ENABLED decision (display only).
    const { email, mobile } = await verifiedContacts(user.id);
    return jsonOk({ id: user.id, contact: user.contact, name: user.name, role: user.role, email, mobile, mobileEnabled: mobileFeaturesEnabled() });
  } catch (error) {
    return jsonError(error);
  }
}
