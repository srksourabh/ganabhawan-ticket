import { query, type Client } from './db';
import { AppError, requireValue } from './errors';
import { normalizeContact } from './security';
import { attemptModeSql } from './payment-mode';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAttempt(body: { name?: string; contact?: string; email?: string; phone?: string; productId?: string; quantity?: number }) {
  const name = (body.name ?? '').trim().slice(0, 120);
  if (!name) throw new AppError(400, 'Enter your name.');
  let email: string;
  let phone: string;
  try {
    email = normalizeContact(body.email ?? '');
    phone = normalizeContact(body.phone ?? '');
  } catch (error) {
    throw new AppError(400, (error as Error).message);
  }
  if (!email.includes('@')) throw new AppError(400, 'Enter your email address.');
  if (phone.includes('@')) throw new AppError(400, 'Enter your mobile number.');
  let contact = email;
  if ((body.contact ?? '').trim()) {
    try { contact = normalizeContact(body.contact ?? ''); } catch { contact = email; }
  }
  const quantity = body.quantity ?? 0;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    throw new AppError(400, 'Choose a valid ticket quantity.');
  }
  const productId = (body.productId ?? '').trim();
  if (!UUID.test(productId)) throw new AppError(400, 'Choose a ticket.');
  return { name, contact, email, phone, productId, quantity };
}

export function summarizeMoney(income: number, refunded: number, pending: number) {
  return { income, refunded, balance: income - refunded, pending };
}

export async function recordBookingAttempt(input: {
  name?: string;
  contact?: string;
  email?: string;
  phone?: string;
  productId?: string;
  quantity?: number;
  userId?: string | null;
}) {
  const parsed = parseAttempt(input);
  const products = await query('SELECT id FROM products WHERE id=$1', [parsed.productId]);
  requireValue(products[0], 'This ticket option is not available.', 404);
  const rows = await query(
    `INSERT INTO booking_attempts(user_id, contact, name, email, phone, product_id, quantity, outcome)
     VALUES($1,$2,$3,$4,$5,$6,$7,'STARTED') RETURNING id, outcome, created_at`,
    [input.userId ?? null, parsed.contact, parsed.name, parsed.email, parsed.phone, parsed.productId, parsed.quantity],
  );
  return rows[0];
}

export async function linkAttempt(
  attemptId: string,
  userId: string,
  contact: string,
  bookingId: string | null,
  outcome: 'HELD' | 'FAILED',
) {
  if (!UUID.test(attemptId)) return;
  await query(
    `UPDATE booking_attempts
     SET user_id=$2, outcome=$3, booking_id=COALESCE($4::uuid, booking_id)
     WHERE id=$1::uuid AND (user_id IS NULL OR user_id=$2) AND contact=$5`,
    [attemptId, userId, outcome, bookingId, contact],
  );
  if (bookingId) {
    // The name entered at checkout becomes the booking's ticket holder (owner-only visibility).
    await query(
      `UPDATE bookings b SET holder_name=COALESCE(b.holder_name, a.name),
         holder_email=COALESCE(b.holder_email, a.email), holder_phone=COALESCE(b.holder_phone, a.phone)
       FROM booking_attempts a
       WHERE a.id=$1::uuid AND b.id=$2::uuid AND b.user_id=$3 AND a.user_id=$3`,
      [attemptId, bookingId, userId],
    );
  }
}

export async function markAttemptsConfirmed(c: Client, bookingId: string) {
  await c.query(`UPDATE booking_attempts SET outcome='CONFIRMED' WHERE booking_id=$1`, [bookingId]);
}

export async function accountsLedger() {
  // Money taken in Razorpay TEST mode is not income: it is reported apart (testIncome) and kept
  // out of income, refunds and balance. Payments with no recorded mode count as before.
  const isTest = `${attemptModeSql()} = 'test'`;
  const [incomeRow] = await query<{ n: string | number; test: string | number }>(
    `SELECT COALESCE(SUM(pay.amount) FILTER (WHERE NOT COALESCE(${isTest}, false)),0)::bigint AS n,
            COALESCE(SUM(pay.amount) FILTER (WHERE ${isTest}),0)::bigint AS test
     FROM payments pay LEFT JOIN payment_attempts pa ON pa.provider_order_id=pay.provider_order_id WHERE pay.state='CAPTURED'`,
  );
  const [refundRow] = await query<{ n: string | number }>(
    `SELECT COALESCE(SUM(r.amount),0)::bigint AS n FROM refunds r JOIN payments pay ON pay.id=r.payment_id
     LEFT JOIN payment_attempts pa ON pa.provider_order_id=pay.provider_order_id
     WHERE r.state='SUCCEEDED' AND NOT COALESCE(${isTest}, false)`,
  );
  const [pendingRow] = await query<{ n: string | number }>(
    `SELECT COALESCE(SUM(total),0)::bigint AS n FROM bookings WHERE status IN ('HELD','PAYMENT_PENDING')`,
  );
  const money = summarizeMoney(Number(incomeRow?.n ?? 0), Number(refundRow?.n ?? 0), Number(pendingRow?.n ?? 0));
  const attempts = await query(
    `SELECT a.id, a.created_at, a.name, a.contact, a.email, a.phone, a.quantity, a.outcome,
            p.name AS product_name, p.category, p.kind,
            b.reference, b.status AS booking_status
     FROM booking_attempts a
     JOIN products p ON p.id = a.product_id
     LEFT JOIN bookings b ON b.id = a.booking_id
     ORDER BY a.created_at DESC
     LIMIT 200`,
  );
  const payments = await query(
    `SELECT pay.amount, pay.state, pay.created_at, COALESCE(b.reference, co.reference) AS reference,
            COALESCE(b.holder_name, u.name) AS name, u.contact, ${attemptModeSql()} AS mode
     FROM payments pay
     LEFT JOIN payment_attempts pa ON pa.provider_order_id = pay.provider_order_id
     LEFT JOIN bookings b ON b.id = pay.booking_id
     LEFT JOIN checkouts co ON co.id = pay.checkout_id
     JOIN users u ON u.id = COALESCE(b.user_id, co.user_id)
     ORDER BY pay.created_at DESC
     LIMIT 80`,
  );
  const refunds = await query(
    `SELECT r.amount, r.state, r.reason, r.created_at, b.reference, COALESCE(b.holder_name, u.name) AS name, u.contact
     FROM refunds r
     JOIN bookings b ON b.id = r.booking_id
     JOIN users u ON u.id = b.user_id
     ORDER BY r.created_at DESC
     LIMIT 80`,
  );
  const cases = await query(
    `SELECT id, key, kind, state, detail, created_at
     FROM reconciliation_cases
     WHERE state='OPEN'
     ORDER BY created_at DESC
     LIMIT 50`,
  );
  return { ...money, testIncome: Number(incomeRow?.test ?? 0), attempts, payments, refunds, cases };
}
