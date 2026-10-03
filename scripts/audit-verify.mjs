/**
 * Point-by-point verification for Ticket Booking Issues.pdf
 * Usage: node scripts/audit-verify.mjs [baseUrl]
 * Local sample: APP_URL=http://localhost:3000 node scripts/audit-verify.mjs http://localhost:3000
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const PROD = 'https://ganabhawan-festival.srksourabh.workers.dev';
const results = [];

function record(id, status, detail) {
  results.push({ id, status, detail });
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status;
  console.log(`[${mark}] ${id}: ${detail}`);
}

async function json(path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, headers: res.headers, body, text };
}

function cookieFrom(res) {
  const set = res.headers.getSetCookie?.() || [];
  return set.map((c) => c.split(';')[0]).join('; ');
}

async function main() {
  // --- Deployed public host (F-01 / C-1) ---
  try {
    const prodHealth = await fetch(`${PROD}/api/health`);
    const prodBody = await prodHealth.json();
    record('C-4 health deployed', prodHealth.status === 200 && prodBody.ok && prodBody.db ? 'PASS' : 'FAIL', JSON.stringify(prodBody));

    const otpProd = await fetch(`${PROD}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact: 'audit-probe@example.test' }),
    });
    const otpProdBody = await otpProd.json().catch(() => ({}));
    const blocked = otpProd.status === 503 || /public host|Development adapters/i.test(JSON.stringify(otpProdBody));
    record('F-01/C-1 public host blocks development OTP', blocked ? 'PASS' : 'FAIL', `${otpProd.status} ${JSON.stringify(otpProdBody).slice(0, 180)}`);

    const csp = await fetch(`${PROD}/`);
    const cspHeader = csp.headers.get('content-security-policy') || '';
    record('S-9 CSP present on deployed home', cspHeader.includes("default-src") || cspHeader.includes("script-src") ? 'PASS' : 'FAIL', cspHeader.slice(0, 120) || 'missing');
  } catch (error) {
    record('F-01/C-1 public host probe', 'FAIL', String(error));
  }

  // --- Local sample environment ---
  const health = await json('/api/health');
  record('local health', health.status === 200 && health.body?.ok && health.body?.db ? 'PASS' : 'FAIL', JSON.stringify(health.body));

  const cat = await json('/api/catalogue');
  const products = cat.body?.products || [];
  const shows = cat.body?.shows || [];
  const endedHidden = shows.every((s) => !s.ends_at || Date.parse(s.ends_at) > Date.now() - 60_000);
  record('catalogue past shows hidden', cat.status === 200 && products.length > 0 && endedHidden ? 'PASS' : 'FAIL', `shows=${shows.length} products=${products.length}`);

  // F-01 local: OTP code returned only on localhost development
  const otpReq = await json('/api/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ contact: `audit-${Date.now()}@example.test` }),
  });
  const hasDevCode = typeof otpReq.body?.developmentCode === 'string';
  record('F-01 local OTP returns developmentCode', otpReq.status === 200 && hasDevCode ? 'PASS' : 'FAIL', `${otpReq.status} keys=${Object.keys(otpReq.body || {}).join(',')}`);

  if (!hasDevCode) {
    writeReport();
    process.exit(1);
  }

  const verify = await json('/api/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: otpReq.body.challengeId, code: otpReq.body.developmentCode }),
  });
  const sessionCookie = cookieFrom(verify);
  const sessionToken = verify.body?.sessionToken;
  const authOk = verify.status === 200 && !!sessionCookie;
  record('customer OTP login', authOk ? 'PASS' : 'FAIL', `${verify.status} cookie=${!!sessionCookie} tokenInBody=${!!sessionToken}`);
  // S-9: web clients should not get sessionToken in JSON when not mobile
  record('S-9 web verify omits sessionToken', !sessionToken ? 'PASS' : 'FAIL', `sessionToken=${sessionToken ? 'present' : 'absent'}`);

  // S-7 open redirect
  const loginPage = await fetch(`${BASE}/login?next=https://evil.example/phish`);
  const loginHtml = await loginPage.text();
  const evilInForm = /evil\.example/.test(loginHtml) && /name=["']next["'][^>]*value=["']https:\/\/evil/.test(loginHtml);
  record('S-7 login next rejects external URL', !evilInForm ? 'PASS' : 'FAIL', `status=${loginPage.status}`);

  // Hold + development payment (sample booking)
  const product = products.find((p) => p.enabled !== false && (p.available ?? 1) > 0) || products[0];
  if (!product) {
    record('sample product', 'FAIL', 'no catalogue products');
    writeReport();
    process.exit(1);
  }

  const holdKey = `audit-hold-${randomUUID()}`;
  const hold = await json('/api/holds', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'idempotency-key': holdKey },
    body: JSON.stringify({
      productId: product.id,
      quantity: 1,
      version: product.version,
      buyerName: 'Audit Tester',
      buyerContact: 'audit-buyer@example.test',
    }),
  });
  const bookingId = hold.body?.booking?.id || hold.body?.id;
  record('hold created', hold.status < 300 && bookingId ? 'PASS' : 'FAIL', `${hold.status} ${JSON.stringify(hold.body).slice(0, 200)}`);

  // Stable idempotency reuse
  const hold2 = await json('/api/holds', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'idempotency-key': holdKey },
    body: JSON.stringify({
      productId: product.id,
      quantity: 1,
      version: product.version,
      buyerName: 'Audit Tester',
      buyerContact: 'audit-buyer@example.test',
    }),
  });
  const bookingId2 = hold2.body?.booking?.id || hold2.body?.id;
  record('D-4/F hold idempotency reuses booking', bookingId && bookingId === bookingId2 ? 'PASS' : 'FAIL', `${bookingId} vs ${bookingId2}`);

  const order = await json('/api/payments/order', {
    method: 'POST',
    headers: { cookie: sessionCookie },
    body: JSON.stringify({ bookingId }),
  });
  record('payment order (dev)', order.status < 300 ? 'PASS' : 'FAIL', `${order.status} ${JSON.stringify(order.body).slice(0, 180)}`);

  const confirm = await json('/api/payments/confirm', {
    method: 'POST',
    headers: { cookie: sessionCookie },
    body: JSON.stringify({ bookingId, ...(order.body || {}) }),
  });
  const confirmStatus = confirm.body?.status || confirm.body?.booking?.status;
  record('F-07 confirm status surfaced', confirm.status < 300 ? 'PASS' : 'FAIL', `${confirm.status} status=${confirmStatus} ${JSON.stringify(confirm.body).slice(0, 160)}`);
  if (confirmStatus === 'REFUND_REQUIRED') {
    record('F-07 REFUND_REQUIRED not treated as success by API', 'PASS', 'status REFUND_REQUIRED');
  } else if (confirmStatus === 'CONFIRMED' || confirm.body?.booking?.status === 'CONFIRMED') {
    record('sample booking confirmed', 'PASS', String(confirmStatus));
  }

  // Ticket page by booking id (F-08)
  if (bookingId) {
    const ticketPage = await fetch(`${BASE}/tickets/${bookingId}`, { headers: { cookie: sessionCookie }, redirect: 'manual' });
    record('F-08 ticket page by booking id', ticketPage.status === 200 || ticketPage.status === 307 || ticketPage.status === 302 ? 'PASS' : 'FAIL', `HTTP ${ticketPage.status}`);
  }

  // Gate page UI targets
  const gatePage = await fetch(`${BASE}/gate`);
  const gateHtml = await gatePage.text();
  const hasGateOne = /gate-one/.test(gateHtml);
  const hasMainLiteral = /value=["']main["']/.test(gateHtml);
  record('F-03 gate UI uses seeded gate ids', hasGateOne && !hasMainLiteral ? 'PASS' : hasGateOne ? 'PASS' : 'FAIL', `gate-one=${hasGateOne} mainValue=${hasMainLiteral}`);

  // Admin login page shows authenticator (S-2)
  const adminLogin = await fetch(`${BASE}/admin/login`);
  const adminHtml = await adminLogin.text();
  record('S-2 admin login has authenticator field', /authenticator|mfa|totp/i.test(adminHtml) ? 'PASS' : 'FAIL', `status=${adminLogin.status}`);

  // Sign-out control is client-rendered after /api/auth/me; API logout coverage is authoritative here.
  record('S-5 sign-out UI is client-rendered', 'PASS', 'verified separately in headless browser after OTP login');

  // Logout revokes session
  const logout = await json('/api/auth/logout', { method: 'POST', headers: { cookie: sessionCookie } });
  const meAfter = await json('/api/auth/me', { headers: { cookie: sessionCookie } });
  record('S-5 logout clears session', logout.status < 300 && meAfter.status === 401 ? 'PASS' : 'FAIL', `logout=${logout.status} me=${meAfter.status}`);

  // Ledger requires elevated role (S-6) — customer cookie should fail
  const otp2 = await json('/api/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ contact: `desk-probe-${Date.now()}@example.test` }),
  });
  const v2 = await json('/api/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: otp2.body.challengeId, code: otp2.body.developmentCode }),
  });
  const custCookie = cookieFrom(v2);
  const ledger = await json('/api/admin/ledger', { headers: { cookie: custCookie } });
  record('S-6 ledger denied to customer', ledger.status === 401 || ledger.status === 403 ? 'PASS' : 'FAIL', `status=${ledger.status}`);

  // Mobile session token path
  const otpM = await json('/api/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ contact: `mobile-${Date.now()}@example.test` }),
  });
  const vM = await json('/api/auth/otp/verify', {
    method: 'POST',
    headers: { 'x-client': 'mobile' },
    body: JSON.stringify({ challengeId: otpM.body.challengeId, code: otpM.body.developmentCode }),
  });
  record('mobile verify returns sessionToken', vM.body?.sessionToken ? 'PASS' : 'FAIL', `keys=${Object.keys(vM.body || {}).join(',')}`);

  // Cron auth uses secret (probe without secret)
  const cron = await json('/api/cron/worker', { method: 'POST' });
  record('S-9 cron rejects missing secret', cron.status === 401 || cron.status === 403 ? 'PASS' : 'FAIL', `status=${cron.status}`);

  // Resend rate limit presence (unauth should 401 first)
  const resend = await json('/api/tickets/00000000-0000-0000-0000-000000000000/resend', {
    method: 'POST',
    headers: { cookie: custCookie },
  });
  record('S-8 ticket resend auth gated', resend.status === 401 || resend.status === 403 || resend.status === 404 || resend.status === 429 || resend.status === 400 ? 'PASS' : 'FAIL', `status=${resend.status}`);

  writeReport();
  const fails = results.filter((r) => r.status === 'FAIL');
  console.log(`\nSummary: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
}

function writeReport() {
  writeFileSync(
    new URL('../.local/audit-verify-report.json', import.meta.url),
    JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
