import { authenticated } from '@/lib/auth';
import { ownedBookings } from '@/lib/commerce';
import { jsonOk, jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await authenticated();
    const { id } = await params;
    const bookings = await ownedBookings(user.id, id);
    if (!bookings[0]) throw new AppError(404, 'Booking not found.');
    return jsonOk(bookings[0]);
  } catch (error) {
    return jsonError(error);
  }
}
