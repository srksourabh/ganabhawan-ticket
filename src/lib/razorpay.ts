import { createHmac } from 'node:crypto';
import { AppError, requireValue } from './errors';
import { safeEqual } from './security';
import { query } from './db';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

export type RazorpayPaymentEntity = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
};

type RazorpayOrderEntity = {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
};

type Collection<T> = { items?: T[] };

/**
 * A pasted secret often carries a trailing newline or space; Razorpay would then refuse every
 * request with 401 "Authentication failed". Key ids and secrets never contain whitespace.
 */
const setting = (name: string) => process.env[name]?.trim() || undefined;

function credentials() {
  const keyId = setting('RAZORPAY_KEY_ID');
  const keySecret = setting('RAZORPAY_KEY_SECRET');
  requireValue(keyId && keySecret, 'Payment provider is not configured.', 503);
  return { keyId: keyId!, keySecret: keySecret! };
}

export function razorpayKeyId() {
  return credentials().keyId;
}

export function razorpayCheckoutDigest(orderId: string, paymentId: string, secret: string) {
  return createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

export function razorpayWebhookDigest(rawBody: string, secret: string) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function signaturesMatch(expected: string, actual: string) {
  if (!expected || !actual) return false;
  try {
    return safeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function assertCheckoutSignature(orderId: string, paymentId: string, signature: string) {
  const { keySecret } = credentials();
  requireValue(orderId && paymentId && signature, 'Payment verification failed.', 400);
  const expected = razorpayCheckoutDigest(orderId, paymentId, keySecret);
  requireValue(signaturesMatch(expected, signature), 'Payment verification failed.', 400);
}

export function assertWebhookSignature(rawBody: string, signature: string) {
  const webhookSecret = setting('RAZORPAY_WEBHOOK_SECRET');
  requireValue(webhookSecret, 'Webhook secret not configured.', 503);
  requireValue(signature, 'Invalid webhook signature.', 400);
  const expected = razorpayWebhookDigest(rawBody, webhookSecret);
  requireValue(signaturesMatch(expected, signature), 'Invalid webhook signature.', 400);
  return webhookSecret;
}

/** Audit action for a Razorpay API refusal (Admin → Ops shows the latest). */
export const PROVIDER_FAILURE_ACTION = 'payment.provider.error';

/**
 * Records why Razorpay refused a request: HTTP status, endpoint (ids masked) and Razorpay's own
 * error code/reason/description. Never a key, secret, amount or customer detail. Best effort:
 * a failure here never changes what the caller sees.
 */
async function recordProviderFailure(status: number, endpoint: string, error?: { code?: string; description?: string; reason?: string }) {
  const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, 300) : null);
  try {
    await query('INSERT INTO audit_events(actor_id,action,entity,detail) VALUES(NULL,$1,$2,$3)', [
      PROVIDER_FAILURE_ACTION,
      'razorpay',
      JSON.stringify({ status, endpoint, code: clip(error?.code), reason: clip(error?.reason), description: clip(error?.description) }),
    ]);
  } catch (failure) {
    console.error('[razorpay] could not record the provider failure', failure instanceof Error ? failure.message : failure);
  }
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function razorpayRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { keyId, keySecret } = credentials();
  let response: Response;
  try {
    response = await fetch(`${RAZORPAY_API}${path}`, {
      ...init,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (isTimeoutError(error)) throw new AppError(504, 'Payment provider timed out. Please wait and retry.', 'PROVIDER_TIMEOUT');
    throw error;
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; description?: string; reason?: string };
  } & T;

  if (!response.ok) {
    // The provider's own text (e.g. "Authentication failed", "Too Many Requests", validation
    // details) is for operators only: logged, and recorded for Admin → Ops (recordProviderFailure).
    const endpoint = path.split('?')[0].replace(/[A-Za-z]+_[A-Za-z0-9]{8,}/g, ':id');
    console.error('[razorpay] request failed', response.status, endpoint, body.error?.description ?? '');
    if (response.status === 401) {
      console.error('[razorpay] authentication failed: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not a valid pair for this Razorpay account and mode');
    }
    await recordProviderFailure(response.status, `${(init?.method ?? 'GET').toUpperCase()} ${endpoint}`, body.error);
    if (response.status === 429) throw new AppError(503, 'The payment service is busy. Please wait a moment and try again.', 'PROVIDER_BUSY');
    throw new AppError(502, 'The payment service is unavailable right now. Please try again in a moment.', 'PROVIDER_ERROR');
  }
  return body;
}

export async function razorpayCreateOrder(input: {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrderEntity> {
  return razorpayRequest<RazorpayOrderEntity>('/orders', {
    method: 'POST',
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    }),
  });
}

export async function razorpayFetchPayment(paymentId: string): Promise<RazorpayPaymentEntity> {
  return razorpayRequest<RazorpayPaymentEntity>(`/payments/${encodeURIComponent(paymentId)}`);
}

export async function razorpayCapturePayment(paymentId: string, amount: number, currency: string) {
  return razorpayRequest<RazorpayPaymentEntity>(`/payments/${encodeURIComponent(paymentId)}/capture`, {
    method: 'POST',
    body: JSON.stringify({ amount, currency }),
  });
}

export async function razorpayListOrderPayments(orderId: string): Promise<RazorpayPaymentEntity[]> {
  const collection = await razorpayRequest<Collection<RazorpayPaymentEntity>>(
    `/orders/${encodeURIComponent(orderId)}/payments`,
  );
  return collection.items ?? [];
}

export async function razorpayFindOrderByReceipt(receipt: string): Promise<RazorpayOrderEntity | null> {
  const collection = await razorpayRequest<Collection<RazorpayOrderEntity>>(
    `/orders?receipt=${encodeURIComponent(receipt)}&count=5`,
  );
  return collection.items?.[0] ?? null;
}

export type RazorpayRefundEntity = {
  id: string;
  amount: number;
  status: string;
  payment_id?: string;
  notes?: Record<string, string>;
};

export async function razorpayListPaymentRefunds(paymentId: string): Promise<RazorpayRefundEntity[]> {
  const collection = await razorpayRequest<Collection<RazorpayRefundEntity>>(
    `/payments/${encodeURIComponent(paymentId)}/refunds`,
  );
  return collection.items ?? [];
}

export async function razorpayFetchRefund(refundId: string): Promise<RazorpayRefundEntity> {
  return razorpayRequest<RazorpayRefundEntity>(`/refunds/${encodeURIComponent(refundId)}`);
}

export async function razorpayRefundPayment(paymentId: string, amount: number, refundKey: string) {
  return razorpayRequest<RazorpayRefundEntity>(`/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    body: JSON.stringify({ amount, notes: { refundId: refundKey } }),
  });
}

export async function ensureCapturedPayment(payment: RazorpayPaymentEntity): Promise<RazorpayPaymentEntity> {
  if (payment.status === 'captured') return payment;
  if (payment.status === 'authorized') {
    return razorpayCapturePayment(payment.id, Number(payment.amount), payment.currency);
  }
  throw new AppError(409, 'Payment is not yet captured. Complete checkout and try again.');
}
