/**
 * Cart checkout: ONE payment for a whole cart.
 *
 *   cart lines ─► createCheckout (all lines held atomically, or none)
 *              ─► createCheckoutPaymentOrder (one Razorpay order = server total)
 *              ─► fulfillCheckout (one verified payment confirms every line,
 *                  or, if any line can no longer be honoured, none: full refund)
 *
 * A checkout is a parent row over ordinary bookings (one booking per ticket
 * type), so tickets, QR codes, the gate, refunds and show cancellation keep
 * working per booking exactly as before.
 */
import { randomBytes } from 'node:crypto';
import { one, query, transaction, type Client } from './db';
import { AppError, requireValue } from './errors';
import { assertLiveConfiguration, developmentAdaptersAllowed, usingDevelopmentPayments } from './env';
import { audit, job } from './audit';
import { hash } from './security';
import {
  assessBooking, commitBooking, expireIn, loadProductForHold, placeHold, refundCase, releaseLiveHold,
  supersedeBooking, supersedeCheckout, type CapturedPayment, type HoldInput,
} from './commerce';
import { ensureProviderOrder } from './provider-order';
import { razorpayKeyId } from './razorpay';
import type { User } from './types';

export const MAX_CHECKOUT_LINES = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Queryable = Pick<Client, 'query'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQL rows are loosely typed
type Row = Record<string, any>;
const LIVE = ['HELD', 'PAYMENT_PENDING'];

/** Validates and canonicalises cart lines (order-independent, one line per product). */
export function normaliseCheckoutLines(raw: unknown): HoldInput[] {
  requireValue(Array.isArray(raw) && raw.length > 0, 'Your cart is empty.', 400);
  const lines = raw as { productId?: unknown; quantity?: unknown; version?: unknown }[];
  requireValue(lines.length <= MAX_CHECKOUT_LINES, `A cart can hold at most ${MAX_CHECKOUT_LINES} ticket types.`, 400);
  const out = lines.map((l) => ({ productId: String(l?.productId ?? ''), quantity: Number(l?.quantity), version: Number(l?.version) }));
  for (const l of out) {
    requireValue(UUID.test(l.productId), 'Choose a ticket.', 400);
    requireValue(Number.isInteger(l.quantity) && l.quantity >= 1, 'Choose a valid ticket quantity.', 400);
    requireValue(Number.isInteger(l.version) && l.version >= 1, 'This price has changed. Please refresh your selection.', 400);
  }
  requireValue(new Set(out.map((l) => l.productId)).size === out.length, 'Each ticket type can appear only once in the cart.', 400);
  return out.sort((a, b) => a.productId.localeCompare(b.productId));
}

function liveBooking(b: Row) {
  return LIVE.includes(b.status) && new Date(b.expires_at).getTime() > Date.now();
}

/** Derived overall state of a checkout from its bookings. */
export function checkoutStatus(bookings: { status: string; expires_at: string | Date }[]) {
  if (bookings.length && bookings.every((b) => b.status === 'CONFIRMED')) return 'CONFIRMED';
  if (bookings.some((b) => b.status === 'REFUND_REQUIRED' || b.status === 'REFUNDED')) return 'REFUND_REQUIRED';
  if (bookings.length && bookings.every((b) => LIVE.includes(b.status) && new Date(b.expires_at).getTime() > Date.now())) {
    return bookings.some((b) => b.status === 'PAYMENT_PENDING') ? 'PAYMENT_PENDING' : 'HELD';
  }
  if (bookings.some((b) => b.status === 'CANCELLED')) return 'CANCELLED';
  return 'EXPIRED';
}

async function checkoutView(db: Queryable, checkoutId: string, userId: string) {
  const co = (await db.query<Row>('SELECT * FROM checkouts WHERE id=$1 AND user_id=$2', [checkoutId, userId])).rows[0];
  requireValue(co, 'Checkout not found.', 404);
  const bookings = (await db.query<Row>(
    'SELECT id, reference, product_id, quantity, unit_price, total, status, expires_at, product_version, snapshot FROM bookings WHERE checkout_id=$1 ORDER BY created_at, id',
    [checkoutId],
  )).rows;
  const live = bookings.filter(liveBooking);
  return {
    id: co.id as string,
    reference: co.reference as string,
    total: Number(co.total),
    currency: co.currency as string,
    status: checkoutStatus(bookings as { status: string; expires_at: string }[]),
    expiresAt: live.length ? new Date(Math.min(...live.map((b) => new Date(b.expires_at).getTime()))).toISOString() : null,
    bookings: bookings.map((b) => ({
      id: b.id, reference: b.reference, productId: b.product_id, name: b.snapshot?.name ?? '', category: b.snapshot?.category ?? '',
      quantity: Number(b.quantity), unitPrice: Number(b.unit_price), total: Number(b.total), status: b.status,
    })),
  };
}

/**
 * Holds every cart line in ONE transaction under the commerce lock: if any line
 * fails (price changed, sold out, sales closed…) the whole transaction rolls
 * back and nothing stays held. Idempotent per (user, key). A retry of the same
 * cart reuses the customer's live checkout; a changed cart supersedes it.
 */
export async function createCheckout(user: User, rawLines: unknown, key: string) {
  requireValue(key.length >= 8 && key.length <= 128, 'A valid idempotency key is required.', 400);
  assertLiveConfiguration();
  const lines = normaliseCheckoutLines(rawLines);
  const result = await transaction(async (c) => {
    const scope = 'checkout:' + user.id;
    const digest = hash(JSON.stringify(lines));
    const previous = await one(c, 'SELECT * FROM idempotency WHERE scope=$1 AND key=$2', [scope, key]);
    if (previous) {
      requireValue(previous.input_digest === digest, 'This request key was already used for another cart.');
      return checkoutView(c, previous.result.id, user.id);
    }
    await expireIn(c);

    // The customer's still-open checkouts: reuse an identical one, supersede the rest.
    const openIds = (await c.query<{ checkout_id: string }>(
      `SELECT DISTINCT checkout_id FROM bookings WHERE user_id=$1 AND checkout_id IS NOT NULL
       AND status IN ('HELD','PAYMENT_PENDING') AND expires_at>now()`,
      [user.id],
    )).rows.map((r) => r.checkout_id);
    for (const openId of openIds) {
      const bookings = (await c.query<Row>('SELECT * FROM bookings WHERE checkout_id=$1 ORDER BY id FOR UPDATE', [openId])).rows;
      const same =
        bookings.length === lines.length &&
        bookings.every(liveBooking) &&
        lines.every((l) => bookings.some((b) => b.product_id === l.productId && Number(b.quantity) === l.quantity && Number(b.product_version) === l.version));
      if (same) {
        await c.query('INSERT INTO idempotency(scope,key,input_digest,result) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [scope, key, digest, JSON.stringify({ id: openId })]);
        return checkoutView(c, openId, user.id);
      }
      await supersedeCheckout(c, openId, user.id);
    }
    // Stray single-ticket holds on these products (older flow) are superseded too.
    const stray = (await c.query<Row>(
      `SELECT * FROM bookings WHERE user_id=$1 AND checkout_id IS NULL AND product_id = ANY($2::uuid[])
       AND status IN ('HELD','PAYMENT_PENDING') AND expires_at>now() ORDER BY id FOR UPDATE`,
      [user.id, lines.map((l) => l.productId)],
    )).rows;
    for (const b of stray) await supersedeBooking(c, b, user.id);

    const held: Row[] = [];
    for (const line of lines) {
      const product = await loadProductForHold(c, line).catch((error) => { throw lineError(error, line.productId); });
      held.push(await placeHold(c, user, line, product).catch((error) => { throw lineError(error, String(product.name)); }));
    }
    const total = held.reduce((sum, b) => sum + Number(b.total), 0);
    const checkout = (await one<{ id: string }>(
      c,
      "INSERT INTO checkouts(reference,user_id,total,currency) VALUES($1,$2,$3,'INR') RETURNING id",
      ['GC-' + randomBytes(5).toString('hex').toUpperCase(), user.id, total],
    ))!;
    await c.query('UPDATE bookings SET checkout_id=$1 WHERE id = ANY($2::uuid[])', [checkout.id, held.map((b) => b.id)]);
    await c.query('INSERT INTO idempotency(scope,key,input_digest,result) VALUES($1,$2,$3,$4)', [scope, key, digest, JSON.stringify({ id: checkout.id })]);
    await audit(c, user.id, 'checkout.create', checkout.id, { lines: lines.length, total });
    return checkoutView(c, checkout.id, user.id);
  }, true);
  return result;
}

function lineError(error: unknown, label: string) {
  if (error instanceof AppError) return new AppError(error.status, `${label}: ${error.message}`, error.code);
  return error;
}

/**
 * One Razorpay order for the checkout. Its amount is the stored checkout total,
 * re-verified against the sum of the bookings' server-computed totals.
 */
export async function createCheckoutPaymentOrder(user: User, checkoutId: string) {
  assertLiveConfiguration();
  requireValue(UUID.test(checkoutId), 'Checkout not found.', 404);
  const prepared = await transaction(async (c) => {
    const co = await one<Row>(c, 'SELECT * FROM checkouts WHERE id=$1 AND user_id=$2 FOR UPDATE', [checkoutId, user.id]);
    requireValue(co, 'Checkout not found.', 404);
    const ids = (await c.query<{ id: string }>('SELECT id FROM bookings WHERE checkout_id=$1 ORDER BY id', [checkoutId])).rows;
    for (const { id } of ids) await expireIn(c, id);
    const bookings = (await c.query<Row>('SELECT * FROM bookings WHERE checkout_id=$1 ORDER BY id FOR UPDATE', [checkoutId])).rows;
    requireValue(bookings.length > 0 && bookings.every(liveBooking), 'Your hold on these tickets has expired. Your cart is unchanged; check out again to reserve them.', 409);
    const sum = bookings.reduce((s, b) => s + Number(b.total), 0);
    requireValue(sum === Number(co!.total), 'Checkout total does not match its tickets.', 409);
    await c.query("UPDATE bookings SET status='PAYMENT_PENDING' WHERE checkout_id=$1 AND status='HELD'", [checkoutId]);

    if (usingDevelopmentPayments()) {
      await c.query(
        "INSERT INTO payment_attempts(checkout_id,provider_order_id,state) VALUES($1,$2,'READY') ON CONFLICT (provider_order_id) DO NOTHING",
        [checkoutId, 'dev-' + checkoutId],
      );
      return { co: co!, provider: 'development' as const, orderId: 'dev-' + checkoutId };
    }
    const openSql = "SELECT * FROM payment_attempts WHERE checkout_id=$1 AND state IN ('CREATING','READY','UNCERTAIN') FOR UPDATE";
    let attempt = await one<Row>(c, openSql, [checkoutId]);
    if (!attempt) {
      attempt = (await one<Row>(
        c,
        `INSERT INTO payment_attempts(checkout_id,state) VALUES($1,'CREATING')
         ON CONFLICT (checkout_id) WHERE checkout_id IS NOT NULL AND state IN ('CREATING','READY','UNCERTAIN') DO NOTHING RETURNING *`,
        [checkoutId],
      )) ?? (await one<Row>(c, openSql, [checkoutId]));
    }
    requireValue(attempt, 'Checkout not found.', 404);
    if (attempt!.state === 'READY' && attempt!.provider_order_id) return { co: co!, provider: 'razorpay' as const, orderId: attempt!.provider_order_id as string };
    return { co: co!, provider: 'razorpay' as const, attemptId: attempt!.id as string };
  }, true);

  const respond = (orderId: string) => ({
    provider: prepared.provider,
    orderId,
    amount: Number(prepared.co.total),
    currency: prepared.co.currency as string,
    keyId: prepared.provider === 'razorpay' ? razorpayKeyId() : 'dev',
    bookingId: prepared.co.id as string, // id used by the confirm/sync fallbacks
    checkoutId: prepared.co.id as string,
  });
  if (prepared.orderId) return respond(prepared.orderId);
  requireValue(prepared.attemptId, 'Checkout not found.', 404);
  const orderId = await ensureProviderOrder({
    attemptId: prepared.attemptId!,
    lockKey: 'pay-order:checkout:' + checkoutId,
    receipt: prepared.co.reference,
    amount: Number(prepared.co.total),
    currency: prepared.co.currency,
    notes: { checkoutId, reference: prepared.co.reference },
    actorId: user.id,
    auditEntity: checkoutId,
  });
  return respond(orderId);
}

/**
 * One verified, captured payment settles the whole checkout in one
 * transaction. All lines are confirmed, or, if any line can no longer be
 * honoured (expired hold with no seats left, show cancelled, product cap), none
 * are: every booking gets a refund of its own total, which together refund the
 * full payment (owner decision: all-or-nothing). Idempotent per provider payment.
 */
export async function fulfillCheckout(checkoutId: string, payment: CapturedPayment) {
  return transaction(async (c) => {
    const co = await one<Row>(c, 'SELECT * FROM checkouts WHERE id=$1 FOR UPDATE', [checkoutId]);
    requireValue(co, 'Checkout not found.', 404);
    requireValue(
      payment.status === 'captured' && Number(payment.amount) === Number(co!.total) && payment.currency === co!.currency,
      'Captured payment does not match this checkout.',
      400,
    );
    const attempt = await one(c, 'SELECT 1 FROM payment_attempts WHERE checkout_id=$1 AND provider_order_id=$2', [checkoutId, payment.orderId]);
    requireValue(attempt, 'Payment order mismatch.', 400);
    const existing = await one<Row>(c, 'SELECT * FROM payments WHERE provider_payment_id=$1', [payment.id]);
    if (existing) {
      requireValue(existing.checkout_id === checkoutId, 'Payment belongs to another checkout.', 400);
      return checkoutView(c, checkoutId, co!.user_id);
    }
    const record = (await one<{ id: string }>(
      c,
      "INSERT INTO payments(checkout_id,provider_payment_id,provider_order_id,amount,currency,state) VALUES($1,$2,$3,$4,$5,'CAPTURED') RETURNING id",
      [checkoutId, payment.id, payment.orderId, payment.amount, payment.currency],
    ))!;
    let bookings = (await c.query<Row>('SELECT * FROM bookings WHERE checkout_id=$1 ORDER BY id FOR UPDATE', [checkoutId])).rows;
    if (bookings.some((b) => ['CONFIRMED', 'REFUND_REQUIRED', 'REFUNDED'].includes(b.status))) {
      // Already settled by an earlier payment: this one is excess and goes back in full.
      await refundCase(c, bookings[0], record.id, Number(payment.amount), 'Excess captured payment (checkout)');
      return checkoutView(c, checkoutId, co!.user_id);
    }
    for (const b of bookings) await expireIn(c, b.id);
    bookings = (await c.query<Row>('SELECT * FROM bookings WHERE checkout_id=$1 ORDER BY id FOR UPDATE', [checkoutId])).rows;
    const assessments = [];
    for (const b of bookings) assessments.push(await assessBooking(c, b));
    // Expired lines must fit together if they share a pool.
    const need = new Map<string, { free: number; want: number }>();
    for (const a of assessments) {
      if (a.live) continue;
      for (const al of a.allocations) {
        const e = need.get(al.pool_id) ?? { free: al.allocation - al.held - al.committed, want: 0 };
        e.want += al.quantity;
        need.set(al.pool_id, e);
      }
    }
    const fits = [...need.values()].every((e) => e.want <= e.free);
    if (fits && assessments.every((a) => a.canFulfill)) {
      for (let i = 0; i < bookings.length; i += 1) await commitBooking(c, bookings[i], assessments[i], record.id, false);
      await c.query('UPDATE payment_attempts SET next_reconcile_at=NULL WHERE checkout_id=$1', [checkoutId]);
      await job(c, 'DELIVERY', 'checkout:' + checkoutId, { checkoutId });
      await audit(c, co!.user_id, 'checkout.confirmed', checkoutId, { paymentId: record.id, bookings: bookings.length });
      return checkoutView(c, checkoutId, co!.user_id);
    }
    for (let i = 0; i < bookings.length; i += 1) {
      const b = bookings[i];
      if (assessments[i].live) await releaseLiveHold(c, b, assessments[i].allocations, 'capture-release:', 'Checkout could not be fulfilled in full');
      if (b.status !== 'CANCELLED') await c.query("UPDATE bookings SET status='REFUND_REQUIRED' WHERE id=$1", [b.id]);
      await refundCase(c, b, record.id, Number(b.total), 'Checkout could not be fulfilled in full');
    }
    await audit(c, co!.user_id, 'checkout.refund_required', checkoutId, { paymentId: record.id });
    return checkoutView(c, checkoutId, co!.user_id);
  }, true);
}

export async function confirmDevelopmentCheckout(user: User, checkoutId: string, orderId: string) {
  assertLiveConfiguration();
  requireValue(developmentAdaptersAllowed(), 'Development payments are not available on a public host.', 403);
  requireValue(usingDevelopmentPayments(), 'Not available when Razorpay is enabled.', 403);
  const co = (await query<Row>('SELECT * FROM checkouts WHERE id=$1 AND user_id=$2', [checkoutId, user.id]))[0];
  requireValue(co, 'Checkout not found.', 404);
  return fulfillCheckout(checkoutId, { id: 'dev-pay-' + checkoutId, orderId, amount: Number(co.total), currency: co.currency, status: 'captured' });
}

export async function findOwnedCheckout(userId: string, checkoutId: string) {
  if (!UUID.test(checkoutId)) return null;
  return (await query<Row>('SELECT * FROM checkouts WHERE id=$1 AND user_id=$2', [checkoutId, userId]))[0] ?? null;
}

export type ReceiptLine = {
  bookingId: string; bookingReference: string; product: string; category: string; kind: string;
  performances: { title: string; startsAt: string }[]; quantity: number; unitPrice: number; lineTotal: number; status: string;
};
export type Receipt = {
  checkoutId: string; reference: string; status: string; currency: string; total: number; createdAt: string;
  customer: { name: string; contact: string };
  payment: { reference: string; paidAt: string; amount: number } | null;
  refunds: { amount: number; state: string; reason: string }[];
  lines: ReceiptLine[];
};

/** The consolidated receipt for one payment: every line with show, date/time, quantity and prices. Owner only. */
export async function checkoutReceipt(userId: string, checkoutId: string): Promise<Receipt> {
  const co = await findOwnedCheckout(userId, checkoutId);
  requireValue(co, 'Receipt not found.', 404);
  return buildReceipt(co!);
}

async function buildReceipt(co: Row): Promise<Receipt> {
  const bookings = await query<Row>(
    'SELECT id, reference, quantity, unit_price, total, status, snapshot, holder_name FROM bookings WHERE checkout_id=$1 ORDER BY created_at, id',
    [co.id],
  );
  const user = (await query<Row>('SELECT name, contact FROM users WHERE id=$1', [co.user_id]))[0];
  const paid = (await query<Row>(
    "SELECT provider_payment_id, created_at, amount FROM payments WHERE checkout_id=$1 AND state='CAPTURED' ORDER BY created_at LIMIT 1",
    [co.id],
  ))[0];
  const refunds = await query<Row>(
    'SELECT r.amount, r.state, r.reason FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE b.checkout_id=$1 ORDER BY r.created_at',
    [co.id],
  );
  return {
    checkoutId: co.id,
    reference: co.reference,
    status: checkoutStatus(bookings as { status: string; expires_at: string }[]),
    currency: co.currency,
    total: Number(co.total),
    createdAt: new Date(co.created_at).toISOString(),
    customer: { name: bookings.find((b) => b.holder_name)?.holder_name ?? user?.name ?? '', contact: user?.contact ?? '' },
    payment: paid ? { reference: paid.provider_payment_id, paidAt: new Date(paid.created_at).toISOString(), amount: Number(paid.amount) } : null,
    refunds: refunds.map((r) => ({ amount: Number(r.amount), state: r.state, reason: r.reason })),
    lines: bookings.map((b) => ({
      bookingId: b.id,
      bookingReference: b.reference,
      product: b.snapshot?.name ?? '',
      category: b.snapshot?.category ?? '',
      kind: b.snapshot?.kind ?? '',
      performances: [...(b.snapshot?.coverage ?? [])]
        .map((s: { title: string; startsAt: string }) => ({ title: s.title, startsAt: new Date(s.startsAt).toISOString() }))
        .sort((x, y) => x.startsAt.localeCompare(y.startsAt)),
      quantity: Number(b.quantity),
      unitPrice: Number(b.unit_price),
      lineTotal: Number(b.total),
      status: b.status,
    })),
  };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const ist = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** Plain-text consolidated receipt (email/SMS body). No secrets; customer's own data only. */
export function receiptText(r: Receipt, appUrl: string) {
  const base = appUrl.replace(/\/$/, '');
  const items = r.lines.map((l, i) => [
    `${i + 1}. ${l.product}${l.category ? ` — ${l.category}` : ''}`,
    ...l.performances.map((p) => `   ${p.title}: ${ist(p.startsAt)}`),
    `   Quantity: ${l.quantity} × ${rupees(l.unitPrice)} = ${rupees(l.lineTotal)}`,
    `   Booking ${l.bookingReference}: ${base}/tickets/${l.bookingId}`,
  ].join('\n'));
  return [
    `Order ${r.reference} is confirmed.`,
    r.payment ? `Payment ${r.payment.reference} on ${ist(r.payment.paidAt)}` : '',
    r.customer.name ? `Customer: ${r.customer.name}` : '',
    '',
    'Items',
    ...items,
    '',
    `Total paid: ${rupees(r.total)}`,
    '',
    `Full receipt: ${base}/receipts/${r.checkoutId}`,
    'Each ticket has its QR code on its booking page. Show it at the venue entrance.',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

/** DELIVERY job for a checkout: one consolidated confirmation. Throws on send failure (job retries). */
export async function deliverCheckout(checkoutId: string) {
  const co = (await query<Row>('SELECT * FROM checkouts WHERE id=$1', [checkoutId]))[0];
  if (!co) return;
  const receipt = await buildReceipt(co);
  if (receipt.status !== 'CONFIRMED') return;
  const { sendMessage } = await import('./auth');
  const { ORGANISATION } = await import('./brand');
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  await sendMessage(receipt.customer.contact, `Your ${ORGANISATION} tickets - ${receipt.reference}`, receiptText(receipt, appUrl));
}
