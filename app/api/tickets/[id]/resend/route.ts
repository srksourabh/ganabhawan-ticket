import { authenticated, rateLimit } from '@/lib/auth';
import { query } from '@/lib/db';
import { deliverBooking } from '@/lib/tickets';
import { jsonOk, jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await authenticated();
    const { id } = await params;

    // Verify ticket ownership
    const rows = await query<{ booking_id: string; user_id: string }>(
      'SELECT t.booking_id, b.user_id FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE t.id=$1',
      [id],
    );
    if (!rows[0]) throw new AppError(404, 'Ticket not found.');
    if (rows[0].user_id !== user.id && user.role !== 'owner') throw new AppError(403, 'Access denied.');
    await rateLimit('resend:' + user.id + ':' + id, 3, 3600);

    await deliverBooking(rows[0].booking_id);
    return jsonOk({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
