/** What a post-payment confirmation says, independent of the channel that carries it. */
export const NO_REFUND = 'A ticket, once booked, cannot be cancelled or refunded.';
export const PICKUP_INSTRUCTION = 'Collect your tickets at the counter before the show. Bring this email and a photo ID. The name on the ID must match the name on this email. Only this email is accepted.';
/** Opening of every confirmation email (the SMS template carries the same instruction: sms.ts). */
export const CONFIRMED_LEAD = `Your booking is confirmed. This email is your ticket. ${PICKUP_INSTRUCTION} ${NO_REFUND}`;
/** The email itself is what the counter accepts, together with a photo ID. */
export const LINK_SIGN_IN_NOTE = 'Show this email at the counter with your photo ID. You do not need an account.';

/**
 * The secure ticket link: the booking's own QR page when the order has one booking,
 * else the customer's ticket list (every booking, each with its QR codes). Both pages
 * show only the signed-in owner's bookings (ownedBookings); ids are random UUIDs.
 */
export function ticketsLink(base: string, bookingIds: string[]) {
  return bookingIds.length === 1 ? `${base}/tickets/${bookingIds[0]}` : `${base}/tickets`;
}

export interface ConfirmationMessage {
  /** Only a paid, issued order is ever announced (re-checked when each channel sends). */
  confirmed: boolean;
  /** Verified contacts only (account-contacts.ts): email gets the email, mobile gets the SMS. */
  email: string | null;
  mobile: string | null;
  subject: string;
  emailText: string;
  /** The HTML ticket email (ticket-email.ts); emailText is its plain-text alternative. */
  emailHtml?: string;
  /** Values for the SMS template (sms.ts renders SMS_CONFIRMATION_TEXT / MSG91 variables). */
  sms: SmsValues;
}

export interface SmsValues { REFERENCE: string; SHOW: string; LINK: string; NAME: string }

/** A short show label for the SMS: the first line's performance, plus how many more lines. */
export function smsShowLabel(titles: string[]) {
  const first = titles[0] ?? 'your show';
  return titles.length > 1 ? `${first} +${titles.length - 1} more` : first;
}

export function appBaseUrl() {
  return (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}
