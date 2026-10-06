/**
 * Sample-data gate + cancel verification for F-03 / F-04.
 * Creates a throwaway show so the festival programme is not damaged.
 */
import { randomUUID, createHash, createDecipheriv } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local' });

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
let fails = 0;
function check(ok, id, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${detail}`);
  if (!ok) fails += 1;
}

async function json(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, body, cookie };
}

async function otpSession(contact) {
  const req = await json('/api/auth/otp/request', { method: 'POST', body: JSON.stringify({ contact }) });
  if (!req.body.developmentCode) throw new Error(`no developmentCode for ${contact}: ${JSON.stringify(req.body)}`);
  const ver = await json('/api/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: req.body.challengeId, code: req.body.developmentCode }),
  });
  if (ver.status >= 300) throw new Error(`verify failed for ${contact}: ${JSON.stringify(ver.body)}`);
  return ver.cookie;
}

const ownerCookie = await otpSession('owner@example.test');
const scannerCookie = await otpSession('scanner@example.test');
const customerCookie = await otpSession(`audit-gate-${Date.now()}@example.test`);

const startsAt = new Date(Date.now() + 5 * 60_000).toISOString();
const created = await json('/api/admin/shows', {
  method: 'POST',
  headers: { cookie: ownerCookie },
  body: JSON.stringify({
    title: 'Audit Throwaway',
    titleBn: 'অডিট',
    troupe: 'Audit Troupe',
    synopsis: 'Temporary show for audit verification.',
    synopsisBn: 'অস্থায়ী',
    startsAt,
    runtime: 90,
    genre: 'Drama',
    status: 'PUBLISHED',
  }),
});
check(created.status === 201 || created.status === 200, 'create throwaway show', `${created.status}`);
const showId = created.body?.id;
if (!showId) {
  console.error(created.body);
  process.exit(1);
}

const adminCat = await json('/api/admin/products', { headers: { cookie: ownerCookie } });
const products = adminCat.body?.products || adminCat.body || [];
const productList = Array.isArray(products) ? products : [];
const product =
  productList.find((p) => p.show_id === showId && p.kind === 'DAILY' && p.category === 'Balcony') ||
  productList.find((p) => p.show_id === showId);
check(!!product, 'throwaway product', product ? product.id : `count=${productList.length}`);

const publicCat = await json('/api/catalogue');
const pubProduct = (publicCat.body?.products || []).find((p) => p.id === product?.id) || product;

const hold = await json('/api/holds', {
  method: 'POST',
  headers: { cookie: customerCookie, 'idempotency-key': `audit-gate-${randomUUID()}` },
  body: JSON.stringify({
    productId: pubProduct.id,
    quantity: 1,
    version: pubProduct.version,
    buyerName: 'Gate Audit',
    buyerContact: 'gate-audit@example.test',
  }),
});
const bookingId = hold.body?.id || hold.body?.booking?.id;
check(!!bookingId, 'hold throwaway booking', `${hold.status} ${bookingId || JSON.stringify(hold.body).slice(0, 120)}`);

const order = await json('/api/payments/order', {
  method: 'POST',
  headers: { cookie: customerCookie },
  body: JSON.stringify({ bookingId }),
});
const confirm = await json('/api/payments/confirm', {
  method: 'POST',
  headers: { cookie: customerCookie },
  body: JSON.stringify({ bookingId, ...(order.body || {}) }),
});
check(
  confirm.body?.status === 'CONFIRMED' || confirm.body?.id,
  'confirm throwaway booking',
  `${confirm.status} ${confirm.body?.status || ''}`,
);

const booking = await json(`/api/bookings/${bookingId}`, { headers: { cookie: customerCookie } });
const ticketId = booking.body?.tickets?.[0]?.id || booking.body?.ticket_ids?.[0];
check(!!ticketId, 'booking lists ticket id', `${booking.status} ${ticketId || JSON.stringify(booking.body).slice(0, 160)}`);

const pass = await json(`/api/tickets/${ticketId}/pass`, { headers: { cookie: customerCookie } });
check(pass.status === 200 && !!pass.body?.qr, 'F-08 pass by ticket id', `${pass.status} keys=${Object.keys(pass.body || {}).join(',')}`);

function decryptToken(value, credentialKey) {
  const key = Buffer.from(createHash('sha256').update(credentialKey).digest('hex'), 'hex');
  const [iv, body, final, tag] = value.split('.').map((x) => Buffer.from(x, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.update(final), decipher.final()]).toString('utf8');
}
let token = '';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const credRow = await db.query(
  `SELECT encrypted_token FROM credentials WHERE ticket_id=$1 AND status='ACTIVE' LIMIT 1`,
  [ticketId],
);
await db.end();
if (credRow.rows[0]?.encrypted_token && process.env.CREDENTIAL_KEY) {
  token = decryptToken(credRow.rows[0].encrypted_token, process.env.CREDENTIAL_KEY);
}
check(!!token, 'decrypt sample ticket token', token ? `len=${token.length}` : 'missing');

const legacy = await json('/api/admission/scan', {
  method: 'POST',
  headers: { cookie: scannerCookie },
  body: JSON.stringify({
    ticketToken: token,
    showId,
    requestId: randomUUID(),
    gateId: 'main',
    deviceId: 'main',
  }),
});
check(
  legacy.body?.result === 'DENIED' && /not authorized|gate|device/i.test(JSON.stringify(legacy.body)),
  'F-03 legacy main denied for scanner',
  JSON.stringify(legacy.body).slice(0, 160),
);

const good = await json('/api/admission/scan', {
  method: 'POST',
  headers: { cookie: scannerCookie },
  body: JSON.stringify({
    ticketToken: token,
    showId,
    requestId: randomUUID(),
    gateId: 'gate-one',
    deviceId: 'gate-one',
  }),
});
const scopeAccepted = !(good.body?.reason || '').toLowerCase().includes('not authorized');
check(scopeAccepted, 'F-03 scanner authorized for gate-one', JSON.stringify(good.body).slice(0, 160));
check(
  good.body?.result === 'ADMITTED' || /entry|window|time/i.test(JSON.stringify(good.body)),
  'F-03 scan reaches admission logic',
  JSON.stringify(good.body).slice(0, 160),
);

const cancel = await json(`/api/admin/shows/${showId}`, {
  method: 'PATCH',
  headers: { cookie: ownerCookie },
  body: JSON.stringify({ status: 'CANCELLED' }),
});
check(cancel.status < 300 && cancel.body?.status === 'CANCELLED', 'F-04 cancel throwaway show', `${cancel.status} ${cancel.body?.status}`);

const after = await json('/api/admission/scan', {
  method: 'POST',
  headers: { cookie: scannerCookie },
  body: JSON.stringify({
    ticketToken: token,
    showId,
    requestId: randomUUID(),
    gateId: 'gate-one',
    deviceId: 'gate-one',
  }),
});
check(
  after.body?.result === 'DENIED' && /not open|cancel|void|not published|performance/i.test(JSON.stringify(after.body)),
  'F-04 cancelled show refused at gate',
  JSON.stringify(after.body).slice(0, 180),
);

console.log(`\nGate flow: ${fails ? fails + ' failed' : 'all passed'}`);
process.exit(fails ? 1 : 0);
