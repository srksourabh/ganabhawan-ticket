import { AppError, requireValue } from './errors';
import { developmentAdaptersAllowed, mobileFeaturesEnabled } from './env';
import { httpsmsConfigured, redactDigits, sendHttpsmsMessage } from './httpsms';

/**
 * Every customer SMS (sign-in codes, ticket confirmations, booking notices).
 *
 * Only while MOBILE_PHONE_NUMBER_ENABLED=true AND MSG91 is fully configured
 * (env.ts mobileFeaturesEnabled). Otherwise no SMS gateway is ever called (MSG91,
 * httpSMS or webhook) and every send throws SmsDisabledError.
 *
 * Live mode: MSG91 only (SMS_PROVIDER=msg91), through the MSG91 Flow API with a
 * DLT-approved template per message kind. There is no httpSMS or webhook fallback:
 * a MSG91 failure is an error, never a silent switch to another gateway.
 *
 *   MSG91_AUTH_KEY             account auth key (server only)
 *   MSG91_OTP_TEMPLATE_ID      sign-in / mobile-verification code template;
 *                              MSG91_OTP_VARIABLE names its code variable (default OTP)
 *   MSG91_TEMPLATE_ID          ticket confirmation template; MSG91_TEMPLATE_VARIABLES maps
 *                              its variable names to REFERENCE, SHOW, LINK, NAME
 *                              (default "REFERENCE=REFERENCE,SHOW=SHOW,LINK=LINK")
 *   MSG91_NOTICE_TEMPLATE_ID   optional: booking-update template (show cancelled);
 *                              MSG91_NOTICE_TEMPLATE_VARIABLES (default "REFERENCE=REFERENCE,LINK=LINK")
 *   MSG91_SENDER_ID            optional DLT sender header
 *
 * The codes are generated, hashed and verified by this application (auth.ts);
 * MSG91 only delivers them. Local development (developmentAdaptersAllowed) may
 * still use the httpSMS or generic webhook gateways for free-text testing.
 */
export type SmsProvider = 'msg91' | 'httpsms' | 'generic' | 'none';

const env = (name: string) => process.env[name]?.trim() ?? '';

/** A send refused because customer mobile features are switched off: never retried, never "delivered". */
export class SmsDisabledError extends AppError {
  constructor() {
    super(503, 'SMS is not available. Please use your email address.', 'MOBILE_DISABLED');
  }
}

export function smsProvider(): SmsProvider {
  if (!mobileFeaturesEnabled()) return 'none';
  const chosen = env('SMS_PROVIDER').toLowerCase();
  if (!developmentAdaptersAllowed()) return chosen === 'msg91' ? 'msg91' : 'none';
  if (chosen === 'msg91' || chosen === 'httpsms' || chosen === 'generic') return chosen;
  if (httpsmsConfigured()) return 'httpsms';
  if (env('SMS_API_URL') && env('SMS_API_TOKEN')) return 'generic';
  return 'none';
}

/** Transactional SMS (confirmations) can be sent. */
export function smsConfigured() {
  switch (smsProvider()) {
    case 'msg91': return Boolean(env('MSG91_AUTH_KEY') && env('MSG91_TEMPLATE_ID'));
    case 'httpsms': return httpsmsConfigured();
    case 'generic': return Boolean(env('SMS_API_URL') && env('SMS_API_TOKEN'));
    default: return false;
  }
}

/** Sign-in codes can be sent by SMS. */
export function otpSmsConfigured() {
  return smsProvider() === 'msg91' ? Boolean(env('MSG91_AUTH_KEY') && env('MSG91_OTP_TEMPLATE_ID')) : smsConfigured();
}

export type SmsMessage = { text: string; variables: Record<string, string> };
type SmsValues = { REFERENCE: string; SHOW: string; LINK: string; NAME: string };

export const PHYSICAL_CARDS_SMS = 'Please collect your physical cards before the show.';
/** Default wording for free-text gateways; the MSG91 DLT template must carry the same text. */
export const DEFAULT_SMS_TEXT = `Your booking for {SHOW} is confirmed. View your QR tickets: {LINK}. ${PHYSICAL_CARDS_SMS} Booking: {REFERENCE}`;
const DLT_VALUE_MAX = 30; // DLT variables are short; long show names are trimmed

/** "name=VALUE,name=VALUE" → { name: values[VALUE] } for the keys that exist in `values`. */
function mapVariables(spec: string, values: Record<string, string>) {
  const pairs = spec.split(',').map((pair) => pair.split('=').map((x) => x.trim())).filter(([name, value]) => name && value in values);
  return Object.fromEntries(pairs.map(([name, value]) => [name, values[value]]));
}

/**
 * The confirmation SMS from the configured template. {REFERENCE}, {SHOW}, {LINK}
 * and {NAME} are the only placeholders. MSG91 sends the template's own text with
 * the mapped variables (MSG91_TEMPLATE_VARIABLES); httpSMS/generic send `text`.
 */
export function renderSms(values: SmsValues): SmsMessage {
  const short: SmsValues = { ...values, SHOW: values.SHOW.length > DLT_VALUE_MAX ? values.SHOW.slice(0, DLT_VALUE_MAX - 1) + '…' : values.SHOW };
  const template = env('SMS_CONFIRMATION_TEXT') || DEFAULT_SMS_TEXT;
  const text = template.replace(/\{(REFERENCE|SHOW|LINK|NAME)\}/g, (_, key: keyof SmsValues) => short[key]);
  return { text, variables: mapVariables(env('MSG91_TEMPLATE_VARIABLES') || 'REFERENCE=REFERENCE,SHOW=SHOW,LINK=LINK', short) };
}

const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow';

/** MSG91 wants the number without '+': 91XXXXXXXXXX. */
export function msg91Payload(to: string, message: SmsMessage, templateId = env('MSG91_TEMPLATE_ID')) {
  const payload: Record<string, unknown> = {
    template_id: templateId,
    short_url: '0',
    recipients: [{ mobiles: to.replace(/^\+/, ''), ...message.variables }],
  };
  if (env('MSG91_SENDER_ID')) payload.sender = env('MSG91_SENDER_ID');
  return payload;
}

/** One MSG91 Flow call. Throws on any failure; logs status and a digit-redacted provider message only. */
async function postMsg91(payload: Record<string, unknown>, kind: string) {
  if (!mobileFeaturesEnabled()) throw new SmsDisabledError(); // defence in depth: no MSG91 call while off
  requireValue(env('MSG91_AUTH_KEY') && payload.template_id, 'SMS delivery is not configured.', 503);
  const response = await fetch(MSG91_FLOW_URL, {
    method: 'POST',
    headers: { authkey: env('MSG91_AUTH_KEY'), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const body = (await response.json().catch(() => ({}))) as { type?: string; message?: string };
  if (!response.ok || body.type !== 'success') {
    // Never the number, code, link, message text or key.
    console.error(`msg91 ${kind} send failed`, response.status, redactDigits(String(body.message ?? '')).slice(0, 200));
    throw new AppError(503, 'SMS delivery is temporarily unavailable.');
  }
}

/** Local development gateways only (httpSMS / generic webhook); never selected in live mode. */
export async function sendFreeTextSms(to: string, text: string, requestId?: string) {
  if (!mobileFeaturesEnabled()) throw new SmsDisabledError();
  const provider = smsProvider();
  if (provider === 'httpsms') return sendHttpsmsMessage(to, text, requestId);
  requireValue(provider === 'generic', 'SMS delivery is not configured.', 503);
  const response = await fetch(process.env.SMS_API_URL!, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.SMS_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, message: text }),
    signal: AbortSignal.timeout(10000),
  });
  requireValue(response.ok, 'SMS delivery is temporarily unavailable.', 503);
}

const validMobile = (to: string) => {
  if (!mobileFeaturesEnabled()) throw new SmsDisabledError();
  requireValue(/^\+[1-9]\d{7,14}$/.test(to), 'Enter a valid mobile number with country code, for example +91.', 400);
};

/** Ticket confirmation. Throws on any provider failure, so the notification job retries. */
export async function sendSms(to: string, message: SmsMessage, requestId?: string) {
  validMobile(to);
  requireValue(smsConfigured(), 'SMS delivery is not configured.', 503);
  if (smsProvider() === 'msg91') return postMsg91(msg91Payload(to, message), 'confirmation');
  return sendFreeTextSms(to, message.text, requestId);
}

/** A sign-in / verification code. `text` is used only by local free-text gateways. */
export async function sendOtpSms(to: string, code: string, text: string, requestId?: string) {
  validMobile(to);
  requireValue(otpSmsConfigured(), 'SMS sign-in codes are not available right now. Please use email.', 503);
  if (smsProvider() !== 'msg91') return sendFreeTextSms(to, text, requestId);
  const variable = env('MSG91_OTP_VARIABLE') || 'OTP';
  return postMsg91(msg91Payload(to, { text: '', variables: { [variable]: code } }, env('MSG91_OTP_TEMPLATE_ID')), 'otp');
}

/** A booking update (show cancelled). MSG91 needs its own approved template: MSG91_NOTICE_TEMPLATE_ID. */
export async function sendNoticeSms(to: string, values: { REFERENCE: string; LINK: string }, text: string, requestId?: string) {
  validMobile(to);
  if (smsProvider() !== 'msg91') {
    requireValue(smsConfigured(), 'SMS delivery is not configured.', 503);
    return sendFreeTextSms(to, text, requestId);
  }
  requireValue(env('MSG91_NOTICE_TEMPLATE_ID'), 'Booking-update SMS needs MSG91_NOTICE_TEMPLATE_ID (an approved MSG91 template).', 503);
  const variables = mapVariables(env('MSG91_NOTICE_TEMPLATE_VARIABLES') || 'REFERENCE=REFERENCE,LINK=LINK', values);
  return postMsg91(msg91Payload(to, { text: '', variables }, env('MSG91_NOTICE_TEMPLATE_ID')), 'notice');
}
