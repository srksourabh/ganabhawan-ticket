import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from './db';
import { secret } from './env';
import { BRAND_LOGO, FESTIVAL, FESTIVAL_BN, ORGANISATION } from './brand';
import { CONFIRMED_LEAD, LINK_SIGN_IN_NOTE, NO_REFUND, PICKUP_INSTRUCTION } from './confirmation';

/**
 * The ticket confirmation email (HTML + the plain-text alternative's ticket section).
 *
 * Every issued ticket is shown on its own with its ticket number (tickets.reference: unique in
 * the database, set once when the payment is verified, never reused) and its QR code. The QR is
 * the ticket's existing ACTIVE credential (the same code as the ticket page and the gate scanner),
 * served as a PNG from /api/ticket-qr/<code>, where <code> is the ticket id with an HMAC: it
 * cannot be guessed or derived from a ticket number, and it stops working when the credential
 * is revoked or the ticket cancelled. Gmail does not show data: images, so the image is hosted.
 * Everything a customer needs (numbers, show, date, venue, instructions) is also text.
 */

const QR_SIG_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function qrSignature(ticketId: string) {
  return createHmac('sha256', secret('CREDENTIAL_KEY')).update('ticket-qr:v1:' + ticketId).digest('base64url').slice(0, QR_SIG_LENGTH);
}

/** The opaque code in a ticket's QR image URL. */
export function ticketQrCode(ticketId: string) {
  return `${ticketId}.${qrSignature(ticketId)}`;
}

/** The ticket id behind a QR image code, or null when the code was not issued by this server. */
export function ticketIdFromQrCode(code: string): string | null {
  const [ticketId, signature, ...rest] = String(code ?? '').split('.');
  if (rest.length || !UUID.test(ticketId ?? '') || !signature || signature.length !== QR_SIG_LENGTH) return null;
  const expected = Buffer.from(qrSignature(ticketId));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected) ? ticketId : null;
}

export function ticketQrUrl(base: string, ticketId: string) {
  return `${base.replace(/\/$/, '')}/api/ticket-qr/${ticketQrCode(ticketId)}`;
}

export type EmailTicket = { id: string; reference: string; bookingId: string };

/** The issued, active tickets of these bookings, in booking then ticket order. */
export async function issuedTickets(bookingIds: string[]): Promise<EmailTicket[]> {
  if (bookingIds.length === 0) return [];
  const rows = await query<{ id: string; reference: string; booking_id: string }>(
    `SELECT t.id, t.reference, t.booking_id FROM tickets t
     WHERE t.booking_id = ANY($1::uuid[]) AND t.status='ACTIVE'
     ORDER BY array_position($1::uuid[], t.booking_id), t.ordinal`,
    [bookingIds],
  );
  return rows.map((r) => ({ id: r.id, reference: r.reference, bookingId: r.booking_id }));
}

/** The plain-text alternative's ticket section: every ticket number with its QR code link. */
export function ticketTextLines(tickets: EmailTicket[], base: string) {
  if (tickets.length === 0) return [];
  return [
    `Ticket numbers (${tickets.length}): one QR code per ticket.`,
    ...tickets.map((t, i) => `${i + 1}. ${t.reference} - QR code: ${ticketQrUrl(base, t.id)}`),
  ];
}

export type TicketEmailLine = {
  bookingId: string;
  product: string;
  kind: string;
  category: string;
  performances: { title: string; startsAt: string }[];
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  confirmed: boolean;
};

/** First line of a confirmation paid in Razorpay TEST mode (no real money). */
export const TEST_BOOKING_NOTE = 'TEST BOOKING: paid in Razorpay test mode, no real money was taken. Test tickets are not valid for entry once live sales start.';

export type TicketEmailModel = {
  base: string;
  /** Paid in Razorpay test mode: the email says so clearly. */
  testMode?: boolean;
  customerName: string;
  orderReference: string;
  venue: string;
  total: number;
  payment: { reference: string; paidAt: string } | null;
  lines: TicketEmailLine[];
  tickets: EmailTicket[];
  supportEmail?: string | null;
  receiptUrl?: string | null;
};

const esc = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const rupees = (paise: number) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;
const ist = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

const C = { ink: '#1c1714', muted: '#5e564c', maroon: '#722f37', gold: '#8a6a12', paper: '#f7f4ef', line: '#e4dcd0', white: '#ffffff' };
const FONT = "font-family:'DM Sans',Helvetica,Arial,sans-serif;";
const SERIF = "font-family:Georgia,'Times New Roman',serif;";

function row(label: string, value: string) {
  return `<tr><td style="${FONT}padding:4px 0;color:${C.muted};font-size:13px;width:38%;vertical-align:top;">${esc(label)}</td>`
    + `<td style="${FONT}padding:4px 0;color:${C.ink};font-size:14px;font-weight:600;vertical-align:top;">${value}</td></tr>`;
}

function ticketCard(t: EmailTicket, index: number, count: number, line: TicketEmailLine | undefined, base: string) {
  const qr = ticketQrUrl(base, t.id);
  const shows = (line?.performances ?? []).map((p) => `${esc(p.title)} &middot; ${esc(ist(p.startsAt))}`).join('<br>');
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:10px;background:${C.white};margin:0 0 14px;">
  <tr>
    <td style="padding:16px 18px;vertical-align:top;">
      <p style="${FONT}margin:0 0 4px;color:${C.gold};font-size:11px;letter-spacing:.12em;text-transform:uppercase;">Ticket ${index + 1} of ${count}</p>
      <p style="${SERIF}margin:0 0 6px;color:${C.ink};font-size:18px;">${esc(line?.product ?? 'Ticket')}</p>
      <p style="${FONT}margin:0 0 10px;color:${C.muted};font-size:13px;">${esc(line?.kind === 'SEASON' ? 'Season ticket' : 'Daily ticket')}${line?.category ? ` &middot; ${esc(line.category)}` : ''}</p>
      ${shows ? `<p style="${FONT}margin:0 0 10px;color:${C.ink};font-size:13px;line-height:1.5;">${shows}</p>` : ''}
      <p style="${FONT}margin:0;color:${C.muted};font-size:12px;">Ticket number</p>
      <p style="font-family:'Courier New',Courier,monospace;margin:0;color:${C.maroon};font-size:20px;font-weight:700;letter-spacing:.04em;">${esc(t.reference)}</p>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:0 18px 16px;">
      <img src="${esc(qr)}" width="200" height="200" alt="QR code for ticket ${esc(t.reference)}" style="display:block;width:200px;height:200px;border:0;outline:none;">
      <p style="${FONT}margin:8px 0 0;color:${C.muted};font-size:12px;">QR code not showing? <a href="${esc(qr)}" style="color:${C.maroon};">Open the QR code for ${esc(t.reference)}</a></p>
    </td>
  </tr>
</table>`;
}

/** The HTML ticket email: email-safe tables and inline styles only (no script, no external CSS). */
export function renderTicketEmailHtml(m: TicketEmailModel) {
  const confirmedLines = m.lines.filter((l) => l.confirmed);
  const lineById = new Map(m.lines.map((l) => [l.bookingId, l]));
  const logo = `${m.base.replace(/\/$/, '')}${BRAND_LOGO}`;
  const items = confirmedLines.map((l) => `
      <tr>
        <td style="${FONT}padding:8px 0;border-top:1px solid ${C.line};color:${C.ink};font-size:14px;">
          <strong>${esc(l.product)}</strong><br>
          <span style="color:${C.muted};font-size:13px;">${esc(l.kind === 'SEASON' ? 'Season ticket' : 'Daily ticket')}${l.category ? ` &middot; ${esc(l.category)}` : ''}</span><br>
          ${l.performances.map((p) => `<span style="font-size:13px;">${esc(p.title)} &middot; ${esc(ist(p.startsAt))}</span>`).join('<br>')}
        </td>
        <td align="right" style="${FONT}padding:8px 0;border-top:1px solid ${C.line};color:${C.ink};font-size:14px;white-space:nowrap;vertical-align:top;">
          ${l.quantity} &times; ${esc(rupees(l.unitPrice))}<br><strong>${esc(rupees(l.lineTotal))}</strong>
        </td>
      </tr>`).join('');
  const cards = m.tickets.map((t, i) => ticketCard(t, i, m.tickets.length, lineById.get(t.bookingId), m.base)).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(FESTIVAL)} tickets ${esc(m.orderReference)}</title>
</head>
<body style="margin:0;padding:0;background:${C.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Booking ${esc(m.orderReference)} is confirmed. ${m.tickets.length} ticket${m.tickets.length === 1 ? '' : 's'} with QR codes inside.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td align="center" style="background:#000000;border-radius:12px 12px 0 0;padding:18px 16px;">
        <img src="${esc(logo)}" width="240" height="100" alt="${esc(ORGANISATION)} logo" style="display:block;width:240px;max-width:100%;height:auto;border:0;">
      </td></tr>
      <tr><td style="background:${C.white};padding:24px 22px;border-left:1px solid ${C.line};border-right:1px solid ${C.line};">
        ${m.testMode ? `<p style="${FONT}margin:0 0 14px;padding:10px 12px;border:2px dashed ${C.maroon};border-radius:8px;color:${C.maroon};font-size:13px;font-weight:700;">${esc(TEST_BOOKING_NOTE)}</p>` : ''}
        <p style="${FONT}margin:0 0 6px;color:${C.gold};font-size:12px;letter-spacing:.14em;text-transform:uppercase;">${esc(FESTIVAL)} &middot; ${esc(FESTIVAL_BN)}</p>
        <h1 style="${SERIF}margin:0 0 14px;color:${C.ink};font-size:28px;line-height:1.15;font-weight:normal;">Your booking is confirmed</h1>
        ${m.customerName ? `<p style="${FONT}margin:0 0 12px;color:${C.ink};font-size:15px;">Dear ${esc(m.customerName)},</p>` : ''}
        <p style="${FONT}margin:0 0 18px;color:${C.ink};font-size:14px;line-height:1.6;">${esc(CONFIRMED_LEAD)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
          ${row('Booking reference', `<span style="font-family:'Courier New',Courier,monospace;">${esc(m.orderReference)}</span>`)}
          ${row('Name', esc(m.customerName))}
          ${row('Venue', esc(m.venue))}
          ${row('Tickets', String(m.tickets.length))}
          ${row('Payment status', m.payment ? `Paid${m.payment.reference ? ` &middot; ${esc(m.payment.reference)}` : ''}${m.payment.paidAt ? ` &middot; ${esc(ist(m.payment.paidAt))}` : ''}` : 'Paid')}
          ${row('Total paid', esc(rupees(m.total)))}
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">${items}</table>
        <h2 style="${SERIF}margin:0 0 12px;color:${C.ink};font-size:20px;font-weight:normal;">Your tickets</h2>
        ${cards || `<p style="${FONT}color:${C.muted};font-size:14px;">Your tickets are listed under the booking reference above.</p>`}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};border-radius:10px;margin:8px 0 0;">
          <tr><td style="padding:14px 16px;">
            <p style="${FONT}margin:0 0 6px;color:${C.ink};font-size:14px;font-weight:700;">Entry instructions</p>
            <p style="${FONT}margin:0 0 6px;color:${C.ink};font-size:13px;line-height:1.6;">${esc(PICKUP_INSTRUCTION)}</p>
            <p style="${FONT}margin:0 0 6px;color:${C.ink};font-size:13px;line-height:1.6;">${esc(LINK_SIGN_IN_NOTE)}</p>
            <p style="${FONT}margin:0 0 6px;color:${C.ink};font-size:13px;line-height:1.6;">Each ticket number and QR code is valid only under the festival's ticketing rules above.</p>
            <p style="${FONT}margin:0;color:${C.maroon};font-size:13px;line-height:1.6;">${esc(NO_REFUND)}</p>
          </td></tr>
        </table>
        ${m.receiptUrl ? `<p style="${FONT}margin:16px 0 0;color:${C.muted};font-size:13px;">Full receipt: <a href="${esc(m.receiptUrl)}" style="color:${C.maroon};">${esc(m.receiptUrl)}</a></p>` : ''}
        ${m.supportEmail ? `<p style="${FONT}margin:8px 0 0;color:${C.muted};font-size:13px;">Questions? Write to <a href="mailto:${esc(m.supportEmail)}" style="color:${C.maroon};">${esc(m.supportEmail)}</a>.</p>` : ''}
      </td></tr>
      <tr><td align="center" style="background:${C.white};border:1px solid ${C.line};border-top:0;border-radius:0 0 12px 12px;padding:14px 16px;">
        <p style="${FONT}margin:0;color:${C.muted};font-size:12px;">${esc(ORGANISATION)} &middot; ${esc(FESTIVAL)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
