import { authenticated } from '@/lib/auth';
import { ownedBookings } from '@/lib/commerce';
import { jsonOk, jsonError } from '@/lib/http';

export async function GET(): Promise<Response> {
  try {
    const user = await authenticated();
    const bookings = await ownedBookings(user.id);
    return jsonOk(bookings);
  } catch (error) {
    return jsonError(error);
  }
}
