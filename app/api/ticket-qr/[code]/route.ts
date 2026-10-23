import QRCode from 'qrcode';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/security';
import { ticketIdFromQrCode } from '@/lib/ticket-email';

const NOT_FOUND = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

/**
 * The QR image of one ticket, linked from its confirmation email (ticket-email.ts). The code is
 * the ticket id with an HMAC, so it cannot be guessed or derived from a ticket number. The image
 * is the ticket's existing ACTIVE credential (the same code as the ticket page and the gate
 * scanner): once the ticket is cancelled or the credential revoked it is no longer served.
 * Outside the proxy matcher: no session, and ticket QR codes work even while sales are closed.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }): Promise<Response> {
  try {
    const ticketId = ticketIdFromQrCode((await params).code);
    if (!ticketId) return NOT_FOUND();
    const row = (await query<{ encrypted_token: string }>(
      `SELECT c.encrypted_token FROM credentials c JOIN tickets t ON t.id=c.ticket_id
       WHERE c.ticket_id=$1 AND c.status='ACTIVE' AND t.status='ACTIVE'`,
      [ticketId],
    ))[0];
    if (!row) return NOT_FOUND();
    const png = await QRCode.toBuffer(decrypt(row.encrypted_token), { type: 'png', width: 400, margin: 2 });
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        // Email image proxies may cache it briefly; the gate checks the credential itself on every scan.
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    console.error('[ticket-qr] failed', error instanceof Error ? error.message : 'error');
    return NOT_FOUND();
  }
}
