import { AppError, requireValue } from './errors';

const EXECUTE_URL = 'https://backend.composio.dev/api/v3.1/tools/execute/GMAIL_SEND_EMAIL';

export function composioGmailConfigured() {
  return Boolean(
    process.env.COMPOSIO_API_KEY?.trim() &&
      (process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim() || process.env.COMPOSIO_USER_ID?.trim()),
  );
}

function composioHeaders() {
  const key = process.env.COMPOSIO_API_KEY!.trim();
  const headerName = key.startsWith('uak_') || key.startsWith('uak-') ? 'x-user-api-key' : 'x-api-key';
  return {
    'Content-Type': 'application/json',
    [headerName]: key,
  };
}

export function buildGmailSendArguments(to: string, subject: string, body: string) {
  return {
    recipient_email: to,
    subject,
    body,
    is_html: false,
    user_id: 'me',
    from_email: process.env.EMAIL_FROM?.trim() || undefined,
  };
}

export async function sendComposioGmail(to: string, subject: string, body: string) {
  requireValue(process.env.COMPOSIO_API_KEY?.trim(), 'Email delivery is not configured (COMPOSIO_API_KEY).', 503);

  const payload: Record<string, unknown> = {
    arguments: buildGmailSendArguments(to, subject, body),
  };
  if (process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim()) {
    payload.connected_account_id = process.env.COMPOSIO_CONNECTED_ACCOUNT_ID.trim();
  }
  if (process.env.COMPOSIO_USER_ID?.trim()) {
    payload.user_id = process.env.COMPOSIO_USER_ID.trim();
  }

  const response = await fetch(EXECUTE_URL, {
    method: 'POST',
    headers: composioHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  let parsed: { error?: string | { message?: string }; successful?: boolean } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    console.error('composio gmail send failed', response.status, message || text.slice(0, 200));
    throw new AppError(503, 'Email delivery is temporarily unavailable.');
  }

  if (parsed.successful === false || parsed.error) {
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    console.error('composio gmail send error', message);
    throw new AppError(503, 'Email delivery is temporarily unavailable.');
  }
}
