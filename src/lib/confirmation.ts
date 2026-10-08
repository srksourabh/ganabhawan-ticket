/** What a post-payment confirmation says, independent of the channel that carries it. */
export const PICKUP_INSTRUCTION = 'Please collect your physical tickets before the show.';

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
