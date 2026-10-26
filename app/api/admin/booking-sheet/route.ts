import { authenticated } from '@/lib/auth';
import { bookingSheet, bookingSheetCsv, physicalTicketCsv, physicalTickets, selectPhysicalTickets } from '@/lib/booking-sheet';
import { AppError } from '@/lib/errors';
import { jsonError, jsonOk } from '@/lib/http';

const ROLES = ['owner', 'finance', 'desk', 'inventory'] as const;

function csvResponse(body: string, filename: string) {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    await authenticated([...ROLES]);
    const url = new URL(request.url);
    const format = url.searchParams.get('format');
    if (format === 'tickets') {
      const booking = url.searchParams.get('booking');
      const ticket = url.searchParams.get('ticket');
      const rows = selectPhysicalTickets(await physicalTickets(), { booking, ticket });
      if ((booking || ticket) && rows.length === 0) throw new AppError(404, 'No sold ticket matches that reference.');
      const filename = ticket ? `ticket-${ticket}.csv` : booking ? `booking-${booking}.csv` : 'sold-tickets.csv';
      return csvResponse(physicalTicketCsv(rows), filename);
    }
    const sheet = await bookingSheet();
    if (format === 'csv') return csvResponse(bookingSheetCsv(sheet.rows), 'ganabhawan-bookings.csv');
    return jsonOk({ ...sheet, tickets: await physicalTickets() });
  } catch (error) {
    return jsonError(error);
  }
}
