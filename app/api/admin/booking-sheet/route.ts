import { authenticated } from '@/lib/auth';
import { bookingSheet, bookingSheetCsv } from '@/lib/booking-sheet';
import { jsonError, jsonOk } from '@/lib/http';

const ROLES = ['owner', 'finance', 'desk', 'inventory'] as const;

export async function GET(request: Request): Promise<Response> {
  try {
    await authenticated([...ROLES]);
    const sheet = await bookingSheet();
    const format = new URL(request.url).searchParams.get('format');
    if (format === 'csv') {
      return new Response(bookingSheetCsv(sheet.rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="ganabhawan-bookings.csv"',
        },
      });
    }
    return jsonOk(sheet);
  } catch (error) {
    return jsonError(error);
  }
}
