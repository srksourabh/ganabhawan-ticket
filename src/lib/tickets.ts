import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { query } from './db';
import { requireValue } from './errors';
import { decrypt } from './security';
import { sendEmail, sendMessage } from './auth';
import { DEFAULT_VENUE, ORGANISATION } from './brand';
import { PICKUP_INSTRUCTION, appBaseUrl, smsShowLabel, type ConfirmationMessage } from './confirmation';
import { verifiedContacts } from './account-contacts';
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

export async function ticketPass(user: User, ticketId: string) {
  const rows = await query<{
    reference: string;
    status: string;
    user_id: string;
    encrypted_token: string;
  }>(
    `SELECT t.reference, t.status, b.user_id, c.encrypted_token
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
  const qr = await QRCode.toDataURL(decrypt(row.encrypted_token), { width: 480, margin: 1 });
  return { qr, reference: row.reference };
}

export function confirmationLinks(appUrl: string, bookingId: string, references: string[]) {
  const base = appUrl.replace(/\/$/, '');
  const page = `${base}/tickets/${bookingId}`;
  return references.map((reference) => `Ticket ${reference}: ${page}`).join('\n');
}

const istTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** Confirmation for a single (non-cart) paid booking; same channels and rules as a checkout's. */
export async function bookingConfirmation(bookingId: string): Promise<ConfirmationMessage | null> {
  const base = appBaseUrl();
  const booking = (await query<{
    user_id: string; contact: string; user_name: string; holder_name: string | null; reference: string; status: string;
    quantity: number; unit_price: number; total: number; snapshot: { name?: string; category?: string; kind?: string; coverage?: { title: string; startsAt: string }[] };
    payment_reference: string | null; paid_at: string | null;
  }>(
    `SELECT b.user_id, u.contact, u.name user_name, b.holder_name, b.reference, b.status, b.quantity, b.unit_price, b.total, b.snapshot,
       (SELECT p.provider_payment_id FROM payments p WHERE p.booking_id=b.id AND p.state='CAPTURED' ORDER BY p.created_at LIMIT 1) payment_reference,
       (SELECT p.created_at FROM payments p WHERE p.booking_id=b.id AND p.state='CAPTURED' ORDER BY p.created_at LIMIT 1) paid_at
     FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.id=$1`,
    [bookingId],
  ))[0];
  if (!booking) return null;
  const tickets = await query<{ reference: string }>("SELECT reference FROM tickets WHERE booking_id=$1 AND status='ACTIVE' ORDER BY ordinal", [bookingId]);
  const name = booking.holder_name || booking.user_name;
  const s = booking.snapshot ?? {};
  const rupees = (paise: number) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;
  const emailText = [
    name ? `Dear ${name},` : '',
    '',
    `Your booking ${booking.reference} is confirmed.`,
    booking.payment_reference && booking.paid_at ? `Payment ${booking.payment_reference} on ${istTime(booking.paid_at)}` : '',
    '',
    `${s.name ?? 'Tickets'}`,
    `Zone: ${s.category ?? ''}${s.kind ? ` · ${s.kind === 'SEASON' ? 'Season ticket' : 'Daily ticket'}` : ''}`,
    ...(s.coverage ?? []).map((p) => `${p.title}: ${istTime(p.startsAt)}`),
    `Quantity: ${booking.quantity} × ${rupees(booking.unit_price)} = ${rupees(booking.total)}`,
    '',
    'Open your tickets and QR codes:',
    confirmationLinks(base, bookingId, tickets.map((t) => t.reference)),
    '',
    PICKUP_INSTRUCTION,
    'Each play has its own QR code on the page. Open it on your phone and show it at the venue entrance. You can keep the page on your Home Screen for offline viewing.',
    '',
    `My tickets: ${base}/tickets`,
  ].filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== '')).join('\n');
  const { email, mobile } = await verifiedContacts(booking.user_id);
  return {
    confirmed: booking.status === 'CONFIRMED' && tickets.length > 0,
    email,
    mobile,
    subject: `Your ${ORGANISATION} tickets - ${booking.reference}`,
    emailText,
    sms: { REFERENCE: booking.reference, SHOW: smsShowLabel([s.coverage?.[0]?.title ?? s.name ?? '']), LINK: `${base}/tickets/${bookingId}`, NAME: name || 'Guest' },
  };
}

/** Re-sends the confirmation to the account (customer "resend tickets"): email if verified, else the mobile. */
export async function deliverBooking(bookingId: string): Promise<void> {
  const message = await bookingConfirmation(bookingId);
  if (!message?.confirmed) return;
  if (message.email) await sendEmail(message.email, message.subject, message.emailText);
  else if (message.mobile) await sendMessage(message.mobile, message.subject, message.emailText);
}

// Re-export for convenience
export { sendMessage };
