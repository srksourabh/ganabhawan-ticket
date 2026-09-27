import { createHmac } from 'node:crypto';
import { AppError, requireValue } from './errors';
import { safeEqual } from './security';

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

function credentials() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
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
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  requireValue(webhookSecret, 'Webhook secret not configured.', 503);
  requireValue(signature, 'Invalid webhook signature.', 400);
  const expected = razorpayWebhookDigest(rawBody, webhookSecret);
  requireValue(signaturesMatch(expected, signature), 'Invalid webhook signature.', 400);
  return webhookSecret;
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
    error?: { description?: string };
  } & T;

  if (!response.ok) {
    throw new AppError(502, body.error?.description || 'Could not reach the payment provider. Please try again.');
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

export async function razorpayRefundPayment(paymentId: string, amount: number) {
  return razorpayRequest<{ id: string }>(`/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}

export async function ensureCapturedPayment(payment: RazorpayPaymentEntity): Promise<RazorpayPaymentEntity> {
  if (payment.status === 'captured') return payment;
  if (payment.status === 'authorized') {
    return razorpayCapturePayment(payment.id, Number(payment.amount), payment.currency);
  }
  throw new AppError(409, 'Payment is not yet captured. Complete checkout and try again.');
}
