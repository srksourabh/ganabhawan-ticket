/** What a post-payment confirmation says, independent of the channel that carries it. */
export const PICKUP_INSTRUCTION = 'Please collect your physical cards before the show.';
/** Opening of every confirmation email (the SMS template carries the same instruction: sms.ts). */
export const CONFIRMED_LEAD = `Your booking is confirmed! View your QR tickets using the secure link below. ${PICKUP_INSTRUCTION}`;
/** The ticket pages are private to the buyer's account: the link is not a login credential. */
export const LINK_SIGN_IN_NOTE = 'The link opens after you sign in to the account you booked with.';

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
