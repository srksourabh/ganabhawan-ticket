import { AppError, requireValue } from './errors';
import { httpsmsConfigured, redactDigits, sendHttpsmsMessage } from './httpsms';

/**
 * Transactional SMS (ticket confirmations). Provider chosen by SMS_PROVIDER:
 *
 *   msg91    MSG91 Flow API (India, DLT): MSG91_AUTH_KEY, MSG91_TEMPLATE_ID (the MSG91 flow template,
 *            which is linked to the DLT-approved template in the MSG91 panel), optional MSG91_SENDER_ID.
 *            MSG91_TEMPLATE_VARIABLES maps the template's variable names to our values, e.g.
 *            "var1=REFERENCE,var2=SHOW,var3=LINK" (default: REFERENCE, SHOW and LINK by those names).
 *   httpsms  the existing httpSMS gateway (HTTPSMS_API_KEY, HTTPSMS_FROM)
 *   generic  the existing SMS_API_URL / SMS_API_TOKEN webhook
 *
 * Unset: httpSMS if configured, else the generic webhook if configured, else none.
 * Sign-in codes keep their own path (auth.ts sendMessage); credentials never leave the server.
 */
export type SmsProvider = 'msg91' | 'httpsms' | 'generic' | 'none';

export function smsProvider(): SmsProvider {
  const chosen = (process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (chosen === 'msg91' || chosen === 'httpsms' || chosen === 'generic') return chosen;
  if (httpsmsConfigured()) return 'httpsms';
  if (process.env.SMS_API_URL?.trim() && process.env.SMS_API_TOKEN?.trim()) return 'generic';
  return 'none';
}

export function smsConfigured() {
  switch (smsProvider()) {
    case 'msg91': return Boolean(process.env.MSG91_AUTH_KEY?.trim() && process.env.MSG91_TEMPLATE_ID?.trim());
    case 'httpsms': return httpsmsConfigured();
    case 'generic': return Boolean(process.env.SMS_API_URL?.trim() && process.env.SMS_API_TOKEN?.trim());
    default: return false;
  }
}

export type SmsMessage = { text: string; variables: Record<string, string> };
type SmsValues = { REFERENCE: string; SHOW: string; LINK: string; NAME: string };

/** Default wording for free-text providers; set SMS_CONFIRMATION_TEXT to match the approved template exactly. */
export const DEFAULT_SMS_TEXT = 'Your Ganabhawan ticket booking {REFERENCE} is confirmed for {SHOW}. View your tickets: {LINK}';
const DLT_VALUE_MAX = 30; // DLT variables are short; long show names are trimmed

/**
 * The confirmation SMS from the configured template. {REFERENCE}, {SHOW}, {LINK}
 * and {NAME} are the only placeholders. MSG91 sends the template's own text with
 * the mapped variables (MSG91_TEMPLATE_VARIABLES); httpSMS/generic send `text`.
 */
export function renderSms(values: SmsValues): SmsMessage {
  const short: SmsValues = { ...values, SHOW: values.SHOW.length > DLT_VALUE_MAX ? values.SHOW.slice(0, DLT_VALUE_MAX - 1) + '…' : values.SHOW };
  const template = process.env.SMS_CONFIRMATION_TEXT?.trim() || DEFAULT_SMS_TEXT;
  const text = template.replace(/\{(REFERENCE|SHOW|LINK|NAME)\}/g, (_, key: keyof SmsValues) => short[key]);
  const mapping = (process.env.MSG91_TEMPLATE_VARIABLES?.trim() || 'REFERENCE=REFERENCE,SHOW=SHOW,LINK=LINK')
    .split(',').map((pair) => pair.split('=').map((x) => x.trim())).filter(([name, value]) => name && value in short);
  const variables = Object.fromEntries(mapping.map(([name, value]) => [name, short[value as keyof SmsValues]]));
  return { text, variables };
}

const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow';

/** MSG91 wants the number without '+': 91XXXXXXXXXX. */
export function msg91Payload(to: string, message: SmsMessage) {
  const payload: Record<string, unknown> = {
    template_id: process.env.MSG91_TEMPLATE_ID?.trim(),
    short_url: '0',
    recipients: [{ mobiles: to.replace(/^\+/, ''), ...message.variables }],
  };
  if (process.env.MSG91_SENDER_ID?.trim()) payload.sender = process.env.MSG91_SENDER_ID.trim();
  return payload;
}

/** Throws on any provider failure, so the notification job retries. */
export async function sendSms(to: string, message: SmsMessage, requestId?: string) {
  requireValue(/^\+[1-9]\d{7,14}$/.test(to), 'Enter a valid mobile number with country code, for example +91.', 400);
  const provider = smsProvider();
  requireValue(smsConfigured(), 'SMS delivery is not configured.', 503);
  if (provider === 'httpsms') return sendHttpsmsMessage(to, message.text, requestId);
  if (provider === 'generic') {
    const response = await fetch(process.env.SMS_API_URL!, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.SMS_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message: message.text }),
      signal: AbortSignal.timeout(10000),
    });
    requireValue(response.ok, 'SMS delivery is temporarily unavailable.', 503);
    return;
  }
  const response = await fetch(MSG91_FLOW_URL, {
    method: 'POST',
    headers: { authkey: process.env.MSG91_AUTH_KEY!.trim(), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(msg91Payload(to, message)),
    signal: AbortSignal.timeout(10000),
  });
  const body = (await response.json().catch(() => ({}))) as { type?: string; message?: string };
  if (!response.ok || body.type === 'error') {
    // Logged without the number, message text or key.
    console.error('msg91 send failed', response.status, redactDigits(String(body.message ?? '')).slice(0, 200));
    throw new AppError(503, 'SMS delivery is temporarily unavailable.');
  }
}
