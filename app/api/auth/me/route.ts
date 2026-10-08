import { authenticated } from '@/lib/auth';
import { verifiedContacts } from '@/lib/account-contacts';
import { jsonOk, jsonError } from '@/lib/http';

export async function GET(): Promise<Response> {
  try {
    const user = await authenticated();
    // Verified contacts only: a mobile is required to buy; email is optional.
    const { email, mobile } = await verifiedContacts(user.id);
    return jsonOk({ id: user.id, contact: user.contact, name: user.name, role: user.role, email, mobile });
  } catch (error) {
    return jsonError(error);
  }
}
