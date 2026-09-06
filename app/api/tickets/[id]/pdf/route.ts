import { authenticated } from '@/lib/auth';
import { ticketPdf } from '@/lib/tickets';
import { jsonError } from '@/lib/http';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await authenticated();
    const { id } = await params;
    const pdfBytes = await ticketPdf(user, id);
    return new Response(pdfBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="ticket-${id}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
