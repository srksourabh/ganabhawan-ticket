import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { query } from './db';
import { requireValue } from './errors';
import { decrypt } from './security';
import { sendMessage } from './auth';
import { DEFAULT_VENUE, ORGANISATION } from './brand';
import type { User } from './types';

export async function ticketPdf(user: User, ticketId: string): Promise<Uint8Array> {
  // Load ticket with credential, ensure owner
  const rows = await query<{
    id: string;
    reference: string;
    ordinal: number;
    status: string;
    booking_id: string;
    user_id: string;
    encrypted_token: string;
    credential_id: string;
    booking_reference: string;
    product_name: string;
    show_title: string;
    starts_at: string;
  }>(
    `SELECT t.id, t.reference, t.ordinal, t.status, t.booking_id,
            b.user_id, c.encrypted_token, c.id credential_id,
            b.reference booking_reference,
            (b.snapshot->>'name') product_name,
            COALESCE(
              (SELECT s.title FROM shows s
               JOIN entitlements e ON e.show_id=s.id
               WHERE e.ticket_id=t.id ORDER BY s.starts_at LIMIT 1),
              ''
            ) show_title,
            COALESCE(
              (SELECT s.starts_at::text FROM shows s
               JOIN entitlements e ON e.show_id=s.id
               WHERE e.ticket_id=t.id ORDER BY s.starts_at LIMIT 1),
              ''
            ) starts_at
     FROM tickets t
     JOIN bookings b ON b.id=t.booking_id
     JOIN credentials c ON c.ticket_id=t.id AND c.status='ACTIVE'
     WHERE t.id=$1`,
    [ticketId],
  );

  const row = rows[0];
  requireValue(row, 'Ticket not found.', 404);
  requireValue(row.user_id === user.id || user.role === 'owner', 'Access denied.', 403);
  requireValue(row.status === 'ACTIVE', 'Ticket is not active.', 409);

  const tokenValue = decrypt(row.encrypted_token);

  // Generate QR code as data URL
  const qrDataUrl = await QRCode.toDataURL(tokenValue, { width: 200, margin: 1 });
  const qrBase64 = qrDataUrl.replace('data:image/png;base64,', '');
  const qrBytes = Buffer.from(qrBase64, 'base64');

  // Build PDF
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([420, 595]);
  const { width, height } = page.getSize();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Header
  page.drawText(ORGANISATION.toUpperCase(), {
    x: 40,
    y: height - 50,
    size: 16,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText(`Venue: ${DEFAULT_VENUE}`, {
    x: 40,
    y: height - 68,
    size: 10,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  page.drawText(`Ticket: ${row.reference}`, {
    x: 40,
    y: height - 95,
    size: 11,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  if (row.product_name) {
    page.drawText(row.product_name, {
      x: 40,
      y: height - 120,
      size: 13,
      font: boldFont,
      color: rgb(0.1, 0.1, 0.1),
    });
  }

  if (row.show_title) {
    page.drawText(`Show: ${row.show_title}`, {
      x: 40,
      y: height - 143,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  }

  if (row.starts_at) {
    const dt = new Date(row.starts_at).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    page.drawText(`Date: ${dt}`, {
      x: 40,
      y: height - 165,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  }

  page.drawText(`Booking: ${row.booking_reference}`, {
    x: 40,
    y: height - 188,
    size: 10,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  page.drawText(`Ticket ${row.ordinal}`, {
    x: 40,
    y: height - 208,
    size: 10,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  // QR code
  const qrImage = await pdfDoc.embedPng(qrBytes);
  const qrSize = 180;
  page.drawImage(qrImage, {
    x: (width - qrSize) / 2,
    y: height - 400,
    width: qrSize,
    height: qrSize,
  });

  page.drawText('Scan at venue entrance', {
    x: (width - 150) / 2,
    y: height - 420,
    size: 10,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });

  page.drawLine({
    start: { x: 40, y: 60 },
    end: { x: width - 40, y: 60 },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });

  page.drawText('Please present this ticket at the gate. Not transferable.', {
    x: 40,
    y: 40,
    size: 8,
    font,
    color: rgb(0.6, 0.6, 0.6),
  });

  return pdfDoc.save();
}

export async function deliverBooking(bookingId: string): Promise<void> {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://localhost:3000';

  const tickets = await query<{
    id: string;
    reference: string;
    user_id: string;
    contact: string;
    booking_reference: string;
    product_name: string;
  }>(
    `SELECT t.id, t.reference, b.user_id,
            u.contact, b.reference booking_reference,
            (b.snapshot->>'name') product_name
     FROM tickets t
     JOIN bookings b ON b.id=t.booking_id
     JOIN users u ON u.id=b.user_id
     WHERE t.booking_id=$1 AND t.status='ACTIVE'
     ORDER BY t.ordinal`,
    [bookingId],
  );

  if (tickets.length === 0) return;

  const { contact, booking_reference } = tickets[0];

  const ticketLinks = tickets
    .map((t) => `Ticket ${t.reference}: ${appUrl}/tickets/${t.id}`)
    .join('\n');

  const message =
    `Your booking ${booking_reference} is confirmed!\n\n` +
    `Download your tickets:\n${ticketLinks}\n\n` +
    `Present each ticket QR code at the venue entrance.`;

  try {
    await sendMessage(contact, `Your ${ORGANISATION} tickets – ${booking_reference}`, message);
  } catch (err) {
    console.error('[deliverBooking] sendMessage failed', err);
  }

  // Mark the delivery job done — handled in jobs.ts
}

// Re-export for convenience
export { sendMessage };
