/** What a post-payment confirmation says, independent of the channel that carries it. */
export const NO_REFUND = 'A ticket, once booked, cannot be cancelled or refunded.';
/** Entry policy: EITHER the digital ticket's QR code is scanned OR a physical ticket is collected from the hall. */
export const ENTRY_OPTIONS = "Entry is available through either QR code scanning of your digital ticket or collection of a physical ticket from the hall. Please follow the venue's entry instructions.";
/** Either method, never both: one ticket admits one person once. */
export const ONE_ENTRY = 'Each ticket admits one person once: a ticket used for entry cannot be used again, by QR code or as a physical ticket.';
export const PICKUP_INSTRUCTION = `${ENTRY_OPTIONS} To collect a physical ticket, bring this email and a photo ID; the name on the ID must match the name on this email. ${ONE_ENTRY}`;
/** Opening of every confirmation email (the SMS template carries the same instruction: sms.ts). */
export const CONFIRMED_LEAD = `Your booking is confirmed. This email is your ticket. ${PICKUP_INSTRUCTION} ${NO_REFUND}`;
/** What to show: the QR code at the gate, or this email with a photo ID at the counter. */
export const LINK_SIGN_IN_NOTE = 'Show the QR code in this email at the gate, or this email and your photo ID at the counter. You do not need an account.';
/** The support line every confirmation carries (address from env.ts supportEmail). */
export const supportLine = (email: string) => `Support: ${email}`;

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
