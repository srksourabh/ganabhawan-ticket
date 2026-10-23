/**
 * Programme inventory as admins and customers see it, the support address, the entry policy and
 * the QR chain from the ticket email to the gate.
 *  - Inventory is per performance and zone (pools: allocation, held, committed). The worked example:
 *    100 seats, 20 sold, 5 held -> 75 available; buying 3 -> 72; webhook redelivery, failed payments
 *    and expiry never change it wrongly; an admin increase is visible to customers at once; a
 *    decrease below sold + held is refused; programme B never moves.
 *  - Support: SUPPORT_EMAIL (Cloudflare Worker variable) when it is one valid address, else the
 *    organisation's official address; never the admin "Contact email" field.
 *  - Entry: either QR scan or a physical ticket from the hall, one entry per ticket.
 *  - The QR image in the email encodes exactly the credential the gate admits, once.
 * Real code on the local test database; Razorpay and Resend are the in-process fakes.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { FakeRazorpay } from './helpers/fake-razorpay';
import { DB_AVAILABLE, checkoutSignature, makeShow, makeUser, resetDatabase, useLiveStagingEnv as liveStagingEnv, webhook } from './helpers/fixtures';
import { ENTRY_OPTIONS, ONE_ENTRY } from '../src/lib/confirmation';
import { ADMIN_POLICY } from '../src/lib/admin-policy';
import { t } from '../src/lib/i18n';
import type { Role, User } from '../src/lib/types';

const skip = !DB_AVAILABLE;
const fake = new FakeRazorpay();
const OFFICIAL = 'samatatsanskritiuttarpara2000@gmail.com';
let checkout: typeof import('../src/lib/checkout');
let payments: typeof import('../src/lib/payments');
let commerce: typeof import('../src/lib/commerce');
let catalogue: typeof import('../src/lib/catalogue');
let inventoryAdmin: typeof import('../src/lib/inventory-admin');
let sales: typeof import('../src/lib/performance-sales');
let jobs: typeof import('../src/lib/jobs');
let admission: typeof import('../src/lib/admission');
let env: typeof import('../src/lib/env');
let query: typeof import('../src/lib/db').query;

before(async () => {
  if (skip) return;
  liveStagingEnv();
  fake.install();
  checkout = await import('../src/lib/checkout');
  payments = await import('../src/lib/payments');
  commerce = await import('../src/lib/commerce');
  catalogue = await import('../src/lib/catalogue');
  inventoryAdmin = await import('../src/lib/inventory-admin');
  sales = await import('../src/lib/performance-sales');
  jobs = await import('../src/lib/jobs');
  admission = await import('../src/lib/admission');
  env = await import('../src/lib/env');
  ({ query } = await import('../src/lib/db'));
});
after(async () => {
  fake.uninstall();
  if (!skip) await (await import('../src/lib/db')).pool.end();
});
beforeEach(async () => {
  if (skip) return;
  liveStagingEnv();
  delete process.env.SUPPORT_EMAIL;
  fake.reset();
  await resetDatabase();
});

const line = (p: { productId: string }, quantity = 1) => ({ productId: p.productId, quantity, version: 1 });
const festivalId = async () => (await query<{ id: string }>('SELECT id FROM festivals LIMIT 1'))[0].id;
const publicAvailable = async (productId: string) => (await catalogue.publicProducts(await festivalId())).find((p) => p.id === productId)?.available;
const pool = async (poolId: string) => (await query<{ allocation: number; held: number; committed: number }>('SELECT allocation, held, committed FROM pools WHERE id=$1', [poolId]))[0];
async function buy(user: User, show: { productId: string }, quantity: number) {
  const co = await checkout.createCheckout(user, [line(show, quantity)], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(user, co.id);
  const p = fake.pay(order.orderId);
  await payments.verifyRazorpayCallback({ razorpay_order_id: order.orderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.orderId, p.id) }, user);
  return { co, payment: p };
}
const capacityOf = async (showId: string) => (await query<{ id: string; version: number }>('SELECT id, version FROM capacities WHERE show_id=$1', [showId]))[0];
const setDaily = async (owner: User, showId: string, dailyAllocation: number) => {
  const cap = await capacityOf(showId);
  return inventoryAdmin.configureCapacity(owner, cap.id, { version: cap.version, ceiling: 500, seasonAllocation: 50, dailyAllocation, onlineSeasonAllocation: 50 });
};

// ---- INVENTORY ------------------------------------------------------------------------------------------

test('worked example: 100 seats, 20 sold, 5 held -> 75 available to customers and admins; buying 3 -> 72; programme B unaffected', { skip }, async () => {
  const a = await makeShow({ allocation: 100, title: 'Programme A' });
  const b = await makeShow({ allocation: 50, title: 'Programme B' });
  for (let i = 0; i < 4; i += 1) await buy(await makeUser(), a, 5); // 20 sold
  await commerce.reserve(await makeUser(), line(a, 5), randomUUID()); // 5 held
  assert.deepEqual(await pool(a.poolId), { allocation: 100, held: 5, committed: 20 });
  assert.equal(await publicAvailable(a.productId), 75, 'customer view');
  const adminZone = (await sales.performanceSalesOverview()).find((p) => p.id === a.showId)!.zones[0];
  assert.deepEqual([adminZone.allocation, adminZone.sold, adminZone.held, adminZone.remaining], [100, 20, 5, 75], 'admin view: total, sold, held, remaining');

  const { payment } = await buy(await makeUser(), a, 3);
  assert.equal(await publicAvailable(a.productId), 72, 'the purchase is reflected');
  assert.deepEqual(await pool(a.poolId), { allocation: 100, held: 5, committed: 23 });

  // Webhook redelivered twice for the same payment: no second decrement.
  for (let i = 0; i < 2; i += 1) {
    const { body, signature } = webhook('payment.captured', { ...payment }, 'payment', 'evt_' + randomUUID());
    await payments.ingestRazorpayWebhook(body, signature);
  }
  await jobs.processJobs();
  assert.deepEqual(await pool(a.poolId), { allocation: 100, held: 5, committed: 23 });
  assert.equal(await publicAvailable(a.productId), 72);
  assert.equal(await publicAvailable(b.productId), 50, 'programme B never moved');
});

test('failed payment holds seats only until expiry; then they return; nothing is sold', { skip }, async () => {
  const a = await makeShow({ allocation: 10 });
  const buyer = await makeUser();
  const co = await checkout.createCheckout(buyer, [line(a, 4)], randomUUID());
  const order = await checkout.createCheckoutPaymentOrder(buyer, co.id);
  fake.pay(order.orderId, { status: 'failed' });
  await query("UPDATE payment_attempts SET next_reconcile_at=now()-interval '1 minute'");
  await payments.reconcileOpenRazorpayPayments(5);
  assert.equal(await publicAvailable(a.productId), 6, 'held while the customer may still retry');
  await query("UPDATE bookings SET expires_at=now()-interval '1 minute' WHERE checkout_id=$1", [co.id]);
  await commerce.expireHolds();
  assert.deepEqual(await pool(a.poolId), { allocation: 10, held: 0, committed: 0 });
  assert.equal(await publicAvailable(a.productId), 10);
  assert.equal(Number((await query<{ n: number }>('SELECT count(*)::int n FROM tickets'))[0].n), 0);
});

test('admin increase is visible to customers at once; decrease below sold + held is refused; programme B unaffected', { skip }, async () => {
  const owner = await makeUser('owner');
  const a = await makeShow({ allocation: 30 });
  const b = await makeShow({ allocation: 40 });
  await buy(await makeUser(), a, 5);
  await commerce.reserve(await makeUser(), line(a, 3), randomUUID());
  assert.equal(await publicAvailable(a.productId), 22);
  await setDaily(owner, a.showId, 60);
  assert.equal(await publicAvailable(a.productId), 52, '30 more seats on sale');
  await assert.rejects(setDaily(owner, a.showId, 7), /below|sold|held|reserved|fewer/i, '8 seats are sold or held');
  assert.deepEqual(await pool(a.poolId), { allocation: 60, held: 3, committed: 5 }, 'nothing changed');
  await setDaily(owner, a.showId, 8);
  assert.equal(await publicAvailable(a.productId), 0, 'exactly sold + held is allowed (sold out)');
  assert.equal(await publicAvailable(b.productId), 40);
  assert.equal((await pool(b.poolId)).allocation, 40);
});

test('only owner and inventory staff can change inventory (server-side route policy)', () => {
  const route = readFileSync(join(import.meta.dirname, '..', 'app', 'api', 'admin', 'inventory', 'route.ts'), 'utf8');
  assert.match(route, /const ROLES = ADMIN_POLICY\.inventory;/);
  assert.equal((route.match(/await authenticated\(\[\.\.\.ROLES\]\)/g) ?? []).length, 3, 'GET, PATCH and POST all authenticate');
  assert.deepEqual([...ADMIN_POLICY.inventory].sort(), ['inventory', 'owner']);
  for (const role of ['customer', 'scanner', 'supervisor', 'finance', 'desk'] as Role[]) assert.ok(!(ADMIN_POLICY.inventory as readonly Role[]).includes(role), role);
});

// ---- SUPPORT EMAIL ---------------------------------------------------------------------------------------

test('support address: SUPPORT_EMAIL when valid, else the official address; the admin field does not change it', { skip }, () => {
  assert.equal(env.supportEmail(), OFFICIAL, 'unset');
  process.env.SUPPORT_EMAIL = '  help@tickets.test  ';
  assert.equal(env.supportEmail(), 'help@tickets.test');
  for (const bad of ['', 'not-an-email', 'a@b.com, c@d.com', 'Samatat <a@b.com>', 'a b@c.com']) {
    process.env.SUPPORT_EMAIL = bad;
    assert.equal(env.supportEmail(), OFFICIAL, JSON.stringify(bad));
  }
});

test('ticket email shows "Support: <mailto>" from SUPPORT_EMAIL (HTML and text) with the entry policy; no secret appears', { skip }, async () => {
  process.env.SUPPORT_EMAIL = 'help@tickets.test';
  await makeShow();
  await query("UPDATE festivals SET contact_email='admin-field@tickets.test'");
  const show = await makeShow();
  const buyer = await makeUser();
  await buy(buyer, show, 2);
  await jobs.processJobs();
  const mail = fake.emails.find((e) => e.to === buyer.contact)!;
  assert.ok(mail.html!.includes('Support: <a href="mailto:help@tickets.test"'), 'HTML support line');
  assert.match(mail.text, /^Support: help@tickets\.test$/m);
  assert.ok(!mail.html!.includes('admin-field@') && !mail.text.includes('admin-field@'), 'admin field not shown');
  for (const body of [mail.html!.replace(/&#39;/g, "'"), mail.text]) {
    assert.ok(body.includes(ENTRY_OPTIONS), 'either QR or physical');
    assert.ok(body.includes(ONE_ENTRY), 'one entry per ticket');
    assert.ok(!/Only this email is accepted/.test(body), 'old physical-only wording gone');
  }
  for (const name of ['RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'SESSION_SECRET', 'CREDENTIAL_KEY', 'CRON_SECRET', 'RESEND_API_KEY']) {
    const value = process.env[name];
    if (value) assert.ok(!mail.html!.includes(value) && !mail.text.includes(value), `${name} not exposed`);
  }
  delete process.env.SUPPORT_EMAIL;
  const other = await makeUser();
  await buy(other, show, 1);
  await jobs.processJobs();
  assert.ok(fake.emails.find((e) => e.to === other.contact)!.html!.includes(`Support: <a href="mailto:${OFFICIAL}"`), 'missing variable: official address');
});

test('customer pages carry the entry policy in English and Bengali, without the old physical-only wording', () => {
  for (const locale of ['en', 'bn'] as const) {
    assert.ok(t(locale, 'checkout.pickup') && t(locale, 'book.who') && t(locale, 'book.emailed'), locale);
    assert.ok(t(locale, 'support.line', { email: 'x@y.z' }).endsWith('x@y.z'), locale);
  }
  assert.ok(t('en', 'checkout.pickup').startsWith(ENTRY_OPTIONS));
  assert.match(t('en', 'checkout.pickup'), /admits one person once/);
  assert.match(t('en', 'book.who'), /QR code .* or collect a physical ticket from the hall/);
  assert.ok(!/Only this email is accepted/.test(t('en', 'checkout.pickup')));
  for (const file of ['src/components/ReceiptView.tsx', 'src/components/TicketDetailView.tsx']) {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    assert.match(source, /t\('checkout\.pickup'\)/, `${file}: entry policy`);
    assert.match(source, /mailto:\$\{supportEmail\}/, `${file}: support link`);
  }
});

// ---- QR: EMAIL -> GATE -------------------------------------------------------------------------------------

test('the QR image in the email encodes exactly the credential the gate admits for that booking, once; a physical ticket for a ticket replaces its QR (one active credential per ticket)', { skip }, async () => {
  const show = await makeShow({ startsInMinutes: 30 });
  const buyer = await makeUser();
  const { co } = await buy(buyer, show, 2);
  await jobs.processJobs();
  const email = await import('../src/lib/ticket-email');
  const { decrypt, hash, encrypt, token } = await import('../src/lib/security');
  const tickets = await query<{ id: string; reference: string; encrypted_token: string }>(
    `SELECT t.id, t.reference, c.encrypted_token FROM tickets t JOIN bookings b ON b.id=t.booking_id
     JOIN credentials c ON c.ticket_id=t.id AND c.status='ACTIVE' WHERE b.checkout_id=$1 ORDER BY t.ordinal`, [co.id]);
  assert.equal(tickets.length, 2);
  const mail = fake.emails.find((e) => e.to === buyer.contact)!;
  const { GET } = await import('../app/api/ticket-qr/[code]/route');
  for (const ticket of tickets) {
    const qrUrl = email.ticketQrUrl(process.env.APP_URL!, ticket.id);
    assert.ok(mail.html!.includes(qrUrl) && mail.html!.includes(ticket.reference), 'the email links this ticket\'s QR');
    const code = email.ticketQrCode(ticket.id);
    const png = Buffer.from(await (await GET(new Request(qrUrl), { params: Promise.resolve({ code }) })).arrayBuffer());
    assert.ok(png.equals(await QRCode.toBuffer(decrypt(ticket.encrypted_token), { type: 'png', width: 400, margin: 2 })), 'the image is the QR of this ticket\'s credential');
  }

  const scanner = await makeUser('scanner');
  await query(`INSERT INTO devices(id,name) VALUES('gate-one','Main') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO staff_scopes(user_id,show_id,gate,device_id) VALUES($1,$2,'gate-one','gate-one')`, [scanner.id, show.showId]);
  const scan = (ticketToken: string, who: User = scanner) => admission.admit(who, { requestId: randomUUID(), ticketToken, showId: show.showId, gateId: 'gate-one', deviceId: 'gate-one' });

  // Ticket 1: the emailed QR, scanned twice at the same moment: exactly one entry.
  const qr1 = decrypt(tickets[0].encrypted_token);
  const both = await Promise.all([scan(qr1), scan(qr1)]);
  assert.deepEqual(both.map((r) => r.result).sort(), ['ADMITTED', 'DENIED']);
  assert.equal((await scan(qr1)).result, 'DENIED', 'no second entry');
  await assert.rejects(scan(qr1, buyer), /permission/i, 'customers cannot scan');

  // Ticket 2: a physical ticket with its own code. The schema allows ONE active credential per
  // ticket (one_active_credential), so issuing it must revoke the emailed QR; both together are refused.
  const physical = token();
  await assert.rejects(
    query("INSERT INTO credentials(ticket_id,digest,encrypted_token,kind,status) VALUES($1,$2,$3,'PHYSICAL','ACTIVE')", [tickets[1].id, hash(physical), encrypt(physical)]),
    /one_active_credential/,
  );
  await query("UPDATE credentials SET status='REVOKED' WHERE ticket_id=$1 AND status='ACTIVE'", [tickets[1].id]);
  await query("INSERT INTO credentials(ticket_id,digest,encrypted_token,kind,status) VALUES($1,$2,$3,'PHYSICAL','ACTIVE')", [tickets[1].id, hash(physical), encrypt(physical)]);
  assert.equal((await scan(decrypt(tickets[1].encrypted_token))).result, 'UNKNOWN', 'the emailed QR no longer enters');
  assert.equal((await scan(physical)).result, 'ADMITTED', 'the physical ticket enters once');
  assert.equal((await scan(physical)).result, 'DENIED');
  assert.deepEqual((await query<{ n: number }>('SELECT count(*)::int n FROM admissions GROUP BY ticket_id ORDER BY 1')).map((r) => r.n), [1, 1], 'one entry per ticket');
});
