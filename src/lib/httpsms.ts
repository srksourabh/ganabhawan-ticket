import { AppError, requireValue } from './errors';

const SEND_URL = 'https://api.httpsms.com/v1/messages/send';

export function otpProvider() {
  return (process.env.OTP_PROVIDER || 'development').trim().toLowerCase();
}

export function httpsmsConfigured() {
  return Boolean(process.env.HTTPSMS_API_KEY?.trim() && process.env.HTTPSMS_FROM?.trim());
}

export function httpsmsEnabled() {
  return otpProvider() === 'httpsms' || httpsmsConfigured();
}

export function buildHttpsmsPayload(to: string, content: string, requestId?: string) {
  const from = (process.env.HTTPSMS_FROM || '').replace(/[\s()-]/g, '');
  const payload: { from: string; to: string; content: string; encrypted: false; request_id?: string } = {
    from,
    to,
    content,
    encrypted: false,
  };
  if (requestId) payload.request_id = requestId;
  return payload;
}

export async function sendHttpsmsMessage(to: string, content: string, requestId?: string) {
  requireValue(process.env.HTTPSMS_API_KEY?.trim(), 'SMS delivery is not configured (HTTPSMS_API_KEY).', 503);
  requireValue(process.env.HTTPSMS_FROM?.trim(), 'SMS delivery is not configured (HTTPSMS_FROM).', 503);

  const payload = buildHttpsmsPayload(to, content, requestId);
  requireValue(/^\+[1-9]\d{7,14}$/.test(payload.from), 'HTTPSMS_FROM must be an international number such as +91XXXXXXXXXX.', 503);
  requireValue(/^\+[1-9]\d{7,14}$/.test(payload.to), 'Enter a valid mobile number with country code, for example +91.', 400);

  const response = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.HTTPSMS_API_KEY!.trim(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    console.error('httpsms send failed', response.status);
    throw new AppError(503, 'SMS delivery is temporarily unavailable.');
  }
}
