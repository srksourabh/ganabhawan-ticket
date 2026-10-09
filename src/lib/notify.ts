import { query, transaction } from './db';
import { job } from './audit';
import { developmentAdaptersAllowed, mobileFeaturesEnabled } from './env';
import { sendEmail } from './auth';
import { SmsDisabledError, renderSms, sendSms, smsConfigured } from './sms';
import { checkoutConfirmation, checkoutStatus } from './checkout';
import { bookingConfirmation } from './tickets';
import { contactsOf } from './account-contacts';
import { appBaseUrl, smsShowLabel, ticketsLink, type ConfirmationMessage, type SmsValues } from './confirmation';

/**
 * Post-payment notifications. A DELIVERY job exists only because a payment was
 * verified and the booking(s) confirmed in the same transaction (commitBooking /
 * fulfillCheckout); the browser callback alone never creates one. One DELIVERY
 * job per checkout (unique key), so callback + webhook + reconciliation cannot
 * announce the same payment twice.
 *
 * Channels follow the customer's VERIFIED contacts: an email for a verified email,
 * an SMS (MSG91) for a verified mobile, both when both exist (at least one is required to buy).
 * The email is sent by the DELIVERY job; the SMS is its own NOTIFY job, so a failure
 * on one channel retries only that channel. Every send that the provider accepted
 * is recorded in notification_deliveries (key = job key) and checked before sending,
 * so a retried job never repeats a delivered message; Resend also gets the key as
 * its Idempotency-Key. A notification failure only retries its job: payment,
 * booking and tickets are never touched.
 */
export type ConfirmationTarget = { checkoutId: string } | { bookingId: string };

export function confirmationFor(target: ConfirmationTarget): Promise<ConfirmationMessage | null> {
  return 'checkoutId' in target ? checkoutConfirmation(target.checkoutId) : bookingConfirmation(target.bookingId);
}

async function alreadyDelivered(key: string) {
  return (await query('SELECT 1 FROM notification_deliveries WHERE key=$1', [key])).length > 0;
}

async function recordDelivered(key: string, channel: 'email' | 'sms') {
  await query('INSERT INTO notification_deliveries(key,channel) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [key, channel]);
}

/** DELIVERY job: queue the SMS (if a verified mobile), then send the email (if a verified email). */
export async function deliverConfirmation(target: ConfirmationTarget, jobKey: string) {
  const message = await confirmationFor(target);
  if (!message?.confirmed) return;
  // Locally without an SMS gateway nothing is queued; in live mode SMS must be configured (env.ts).
  // No SMS job at all while mobile features are off (MOBILE_PHONE_NUMBER_ENABLED): the email goes alone.
  if (message.mobile && mobileFeaturesEnabled() && (smsConfigured() || !developmentAdaptersAllowed())) {
    await transaction((c) => job(c, 'NOTIFY', `sms:${jobKey}`, { channel: 'sms', ...target }));
  }
  if (message.email && !(await alreadyDelivered(jobKey))) {
    await sendEmail(message.email, message.subject, message.emailText, jobKey);
    await recordDelivered(jobKey, 'email');
  }
}

/**
 * What the SMS needs, in ONE query (the full receipt costs six, and every query is a
 * Worker subrequest): paid-and-confirmed (same status rule as the receipt), the
 * verified mobile, and the SMS values.
 */
export async function smsConfirmationFor(target: ConfirmationTarget): Promise<{ confirmed: boolean; mobile: string | null; values: SmsValues } | null> {
  const byCheckout = 'checkoutId' in target;
  const row = (await query<{
    reference: string; contact: string; verified_mobile: string | null; name: string | null; paid: boolean;
    lines: { id: string; status: string; expires_at: string; title: string; tickets: number }[];
  }>(
    `SELECT x.reference, u.contact, u.verified_mobile,
       COALESCE((SELECT b.holder_name FROM bookings b WHERE ${byCheckout ? 'b.checkout_id' : 'b.id'}=x.id AND b.holder_name IS NOT NULL LIMIT 1), NULLIF(u.name,'')) name,
       EXISTS (SELECT 1 FROM payments p WHERE ${byCheckout ? 'p.checkout_id' : 'p.booking_id'}=x.id AND p.state='CAPTURED') paid,
       (SELECT COALESCE(json_agg(json_build_object('id',b.id,'status',b.status,'expires_at',b.expires_at,
          'title',COALESCE(b.snapshot->'coverage'->0->>'title', b.snapshot->>'name'),
          'tickets',(SELECT count(*) FROM tickets t WHERE t.booking_id=b.id AND t.status='ACTIVE')) ORDER BY b.created_at, b.id),'[]'::json)
        FROM bookings b WHERE ${byCheckout ? 'b.checkout_id' : 'b.id'}=x.id) lines
     FROM ${byCheckout ? 'checkouts' : 'bookings'} x JOIN users u ON u.id=x.user_id WHERE x.id=$1`,
    [byCheckout ? target.checkoutId : target.bookingId],
  ))[0];
  if (!row) return null;
  const status = byCheckout ? checkoutStatus(row.lines) : row.lines[0]?.status;
  const issued = byCheckout || Number(row.lines[0]?.tickets ?? 0) > 0;
  const base = appBaseUrl();
  return {
    confirmed: row.paid && issued && (status === 'CONFIRMED' || status === 'PARTIALLY_CANCELLED'),
    mobile: contactsOf(row.contact, row.verified_mobile).mobile,
    values: {
      REFERENCE: row.reference,
      SHOW: smsShowLabel(row.lines.filter((l) => l.status === 'CONFIRMED').map((l) => l.title)),
      LINK: ticketsLink(base, byCheckout ? row.lines.filter((l) => l.status === 'CONFIRMED').map((l) => l.id) : [target.bookingId]),
      NAME: row.name || 'Guest',
    },
  };
}

/** NOTIFY job (SMS to the verified mobile). */
export async function sendSmsConfirmation(target: ConfirmationTarget, jobKey: string) {
  // A job queued before mobile features were switched off: never sent, never recorded as delivered.
  if (!mobileFeaturesEnabled()) throw new SmsDisabledError();
  const message = await smsConfirmationFor(target);
  if (!message?.confirmed || !message.mobile) return;
  if (developmentAdaptersAllowed() && !smsConfigured()) return; // local development: no SMS gateway
  if (await alreadyDelivered(jobKey)) return;
  await sendSms(message.mobile, renderSms(message.values), jobKey);
  await recordDelivered(jobKey, 'sms');
}
