/**
 * DEMO preview of the customer ticket confirmation email: the production template
 * (src/lib/ticket-email.ts renderTicketEmailHtml, unchanged) filled with made-up sample data.
 *
 *   npm run preview:email                          # writes .local/email-preview/ticket-email-demo.html
 *   npm run preview:email -- path/to/file.html     # or any other path
 *
 * Open the file in a browser. Nothing is sent, stored or fetched: no email provider, no
 * database (this script points the app at a non-existent env file and an unreachable database,
 * so no real setting is even loaded), no booking, payment or ticket. The QR codes are DEMO codes
 * (they encode "DEMO … NOT VALID FOR ENTRY"), and the page carries a DEMO banner.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import QRCode from 'qrcode';

const PREVIEW_BASE = 'https://preview.invalid';

export const DEMO_BANNER = 'DEMO PREVIEW: sample data only. Not a real booking, not valid for entry, and no email was sent.';
export const DEMO_QR_LABEL = 'DEMO QR (not valid for entry).';

/** Isolate the preview from every real setting before any app module is imported. */
function isolate() {
  process.env.ENV_FILE = resolve('.local/email-preview/no-such-env-file');
  process.env.DATABASE_URL = 'postgresql://preview:preview@preview-no-database.invalid:5432/none';
  // Only signs the (unused) hosted QR links in the template; replaced by inline demo images below.
  process.env.CREDENTIAL_KEY = 'demo-preview-credential-key-not-a-real-secret-000';
}

/** The complete customer email for a realistic but fictitious booking (2 Premier tickets). */
export async function renderDemoTicketEmail(): Promise<{ subject: string; html: string }> {
  const { renderTicketEmailHtml, ticketQrUrl } = await import('../src/lib/ticket-email');
  const { BRAND_LOGO, DEFAULT_VENUE, DEFAULT_VENUE_PLACE, ORGANISATION } = await import('../src/lib/brand');
  const bookingId = '00000000-0000-4000-8000-000000000001';
  const tickets = [
    { id: '00000000-0000-4000-8000-0000000000a1', reference: 'DEMO-TKT-0001', bookingId },
    { id: '00000000-0000-4000-8000-0000000000a2', reference: 'DEMO-TKT-0002', bookingId },
  ];
  const reference = 'DEMO-GF-2026';
  let html = renderTicketEmailHtml({
    base: PREVIEW_BASE,
    customerName: 'Demo Customer',
    orderReference: reference,
    venue: `${DEFAULT_VENUE}, ${DEFAULT_VENUE_PLACE}`,
    total: 100000,
    payment: { reference: 'pay_DEMO000000000', paidAt: '2026-12-01T10:30:00+05:30' },
    lines: [{
      bookingId, product: 'Macbeth 2.0 – Premier', kind: 'DAILY', category: 'Premier',
      performances: [{ title: 'Macbeth 2.0', startsAt: '2026-12-19T18:30:00+05:30' }],
      quantity: 2, unitPrice: 50000, lineTotal: 100000, confirmed: true,
    }],
    tickets,
    supportEmail: 'support@example.invalid',
    receiptUrl: `${PREVIEW_BASE}/receipts/demo`,
  });
  // Hosted images → inline data, so the file opens offline and nothing is fetched.
  for (const t of tickets) {
    const demoQr = await QRCode.toDataURL(`DEMO ${t.reference} - NOT VALID FOR ENTRY`, { width: 400, margin: 2 });
    html = html.split(ticketQrUrl(PREVIEW_BASE, t.id)).join(demoQr);
  }
  const logo = `data:image/png;base64,${readFileSync(resolve('public' + BRAND_LOGO)).toString('base64')}`;
  html = html.split(`${PREVIEW_BASE}${BRAND_LOGO}`).join(logo);
  html = html.split('QR code not showing?').join(`<strong style="color:#722f37;">${DEMO_QR_LABEL}</strong> QR code not showing?`);
  html = html.replace(/<body([^>]*)>/, `<body$1>\n<div style="font-family:Helvetica,Arial,sans-serif;background:#722f37;color:#ffffff;text-align:center;padding:12px 16px;font-size:14px;font-weight:700;letter-spacing:.02em;">${DEMO_BANNER}</div>`);
  return { subject: `[DEMO] Your ${ORGANISATION} tickets - ${reference}`, html };
}

if (process.argv[1] && /preview-ticket-email\.ts$/.test(process.argv[1])) {
  const out = resolve(process.argv[2] || '.local/email-preview/ticket-email-demo.html');
  isolate();
  const { subject, html } = await renderDemoTicketEmail();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`Subject: ${subject}`);
  console.log(`DEMO email preview written to ${out} (nothing was sent). Open it in a browser.`);
}
