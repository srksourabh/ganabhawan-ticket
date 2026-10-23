import { query, type Client } from './db';
import { paymentMode, type PaymentMode } from './env';

/**
 * The Razorpay environment each payment was made in, recorded on its order
 * (payment_attempts.provider_mode, migration 0011) when the order is created and never rewritten.
 * Everything else derives a payment's mode from its order (payments.provider_order_id), so
 * switching the server's keys never reinterprets an existing payment. NULL = not recorded (orders
 * from before 0011, or development payments): treated exactly as before.
 *
 * Reads use attemptModeSql (to_jsonb), so they work before 0011 is applied (always NULL then);
 * the single write checks that the column exists first (paymentModeRecorded).
 */
export const attemptModeSql = (alias = 'pa') => `(to_jsonb(${alias})->>'provider_mode')`;

let columnCheck: Promise<boolean> | null = null;

/** Whether payment_attempts.provider_mode exists (migration 0011). Cached per process; a failed check is retried. */
export function paymentModeRecorded(): Promise<boolean> {
  columnCheck ??= query<{ ok: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_attempts' AND column_name='provider_mode') ok",
  ).then((rows) => rows[0]?.ok === true).catch(() => { columnCheck = null; return false; });
  return columnCheck;
}

type Db = { query: Client['query'] };

/** The recorded mode of a booking's payment (single booking or its cart checkout), or null when not recorded. */
export async function bookingPaymentMode(bookingId: string, db?: Db): Promise<PaymentMode | null> {
  const sql =
    `SELECT ${attemptModeSql()} mode FROM bookings b
     JOIN payments p ON p.state='CAPTURED' AND (p.booking_id=b.id OR (b.checkout_id IS NOT NULL AND p.checkout_id=b.checkout_id))
     JOIN payment_attempts pa ON pa.provider_order_id=p.provider_order_id
     WHERE b.id=$1 ORDER BY p.created_at LIMIT 1`;
  const rows = db ? (await db.query<{ mode: string | null }>(sql, [bookingId])).rows : await query<{ mode: string | null }>(sql, [bookingId]);
  const mode = rows[0]?.mode;
  return mode === 'test' || mode === 'live' ? mode : null;
}

/**
 * A payment made in Razorpay TEST mode while the server now runs LIVE: its tickets were never paid
 * for with real money, so they must not admit anyone (admission.ts) and its refunds cannot go to
 * the live account (refunds.ts).
 */
export function isTestPaymentInLiveMode(recorded: PaymentMode | null) {
  return recorded === 'test' && paymentMode() === 'live';
}

/** A recorded mode that differs from the server's current one (refunds and reconciliation must not cross). */
export function isOtherPaymentMode(recorded: PaymentMode | null) {
  const current = paymentMode();
  return recorded !== null && current !== null && recorded !== current;
}
