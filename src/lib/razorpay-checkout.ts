/** Client-side Razorpay Checkout helper. Loads checkout.js once, then opens the modal. */

export type RazorpayOrder = {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  bookingId: string;
  provider?: 'development' | 'razorpay';
};

export type RazorpaySuccess = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

type RazorpayInstance = {
  open: () => void;
  on: (event: string, handler: (response: { error?: { description?: string } }) => void) => void;
};

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Razorpay requires a browser.'));
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-razorpay-checkout]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Razorpay Checkout.')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpayCheckout = '1';
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Failed to load Razorpay Checkout.'));
    };
    document.body.appendChild(script);
  });
  return scriptPromise;
}

export function prefillFromContact(contact?: string, name?: string) {
  const prefill: { name?: string; email?: string; contact?: string } = {};
  if (name) prefill.name = name;
  if (contact?.includes('@')) prefill.email = contact;
  else if (contact) prefill.contact = contact;
  return prefill;
}

export async function openRazorpayCheckout(
  order: RazorpayOrder,
  opts: { name: string; description: string; prefillEmail?: string; prefillContact?: string; prefillName?: string },
): Promise<RazorpaySuccess> {
  await loadCheckoutScript();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error('Razorpay Checkout is unavailable.');

  const prefill = {
    ...prefillFromContact(opts.prefillEmail?.includes('@') ? opts.prefillEmail : opts.prefillContact, opts.prefillName),
    ...(opts.prefillEmail ? { email: opts.prefillEmail } : {}),
    ...(opts.prefillContact ? { contact: opts.prefillContact } : {}),
    ...(opts.prefillName ? { name: opts.prefillName } : {}),
  };

  // With retry enabled, Razorpay keeps the modal open after a failed attempt so
  // the customer can pay again. A failure therefore must not settle this promise:
  // only the final outcome does (success handler, or the customer closing the
  // modal). Settling early lost a later successful retry, leaving the cart unpaid
  // in the browser while the server confirmed the booking.
  let lastFailure = '';
  return new Promise((resolve, reject) => {
    const rzp = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: opts.name,
      description: opts.description,
      image: `${window.location.origin}/images/samatat/logo.png`,
      order_id: order.orderId,
      timeout: 540,
      retry: { enabled: true, max_count: 1 },
      notes: { bookingId: order.bookingId },
      prefill: Object.keys(prefill).length ? prefill : undefined,
      theme: { color: '#c9a227' },
      handler: (response: RazorpaySuccess) => resolve(response),
      modal: {
        ondismiss: () => reject(new Error(lastFailure || 'Payment cancelled.')),
      },
    });
    rzp.on('payment.failed', (response) => {
      lastFailure = response.error?.description || 'Payment failed.';
    });
    rzp.open();
  });
}

export async function createClientPaymentOrder(bookingId: string): Promise<RazorpayOrder & { provider: 'development' | 'razorpay' }> {
  const res = await fetch('/api/payments/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Unable to create a payment order.');
  return body as RazorpayOrder & { provider: 'development' | 'razorpay' };
}

export type CheckoutSummary = { id: string; reference: string; total: number; status: string; unauthenticated?: boolean };

/** Holds the whole cart server-side (all lines or none) and returns the ONE checkout to pay. */
export async function createClientCheckout(
  lines: { productId: string; quantity: number; version: number; attemptId?: string }[],
  idempotencyKey: string,
): Promise<CheckoutSummary> {
  const res = await fetch('/api/checkouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ lines }),
  });
  if (res.status === 401) return { id: '', reference: '', total: 0, status: '', unauthenticated: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string; productId?: string };
  if (!res.ok) throw new CheckoutLineError(body.error || 'Unable to reserve these tickets.', body.productId);
  return body as unknown as CheckoutSummary;
}

/**
 * The server refused the checkout. With `productId` it names the cart line that
 * cannot be bought (closed, sold out, price changed, unavailable): nothing was
 * held and no payment order exists, so that line must be removed or changed first.
 */
export class CheckoutLineError extends Error {
  constructor(message: string, public productId?: string) { super(message); }
}

/** ONE payment order for the checkout's server-computed total. */
export async function createClientCheckoutOrder(checkoutId: string): Promise<RazorpayOrder & { provider: 'development' | 'razorpay' }> {
  const res = await fetch('/api/payments/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkoutId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Unable to create a payment order.');
  return body as RazorpayOrder & { provider: 'development' | 'razorpay' };
}

export async function confirmRazorpayPayment(response: RazorpaySuccess) {
  const res = await fetch('/api/payments/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Payment confirmation failed.');
  return assertBookingIssued(body);
}

/**
 * The server's booking state is authoritative; HTTP 200 alone means nothing.
 * Only CONFIRMED is success. A paid booking that could not be issued
 * (REFUND_REQUIRED / CANCELLED / REFUNDED) throws 'REFUND_REQUIRED' so the UI
 * shows the refund message; any other state is reported as not confirmed.
 */
export function assertBookingIssued(body: unknown) {
  const status = body && typeof body === 'object' && 'status' in body ? String((body as { status?: unknown }).status ?? '') : '';
  // PARTIALLY_CANCELLED: paid and issued; a line's show was cancelled since (that line refunded).
  if (status === 'CONFIRMED' || status === 'PARTIALLY_CANCELLED') return body;
  if (status === 'REFUND_REQUIRED' || status === 'CANCELLED' || status === 'REFUNDED') {
    throw new Error('REFUND_REQUIRED');
  }
  throw new Error('Your payment is being checked. Open My tickets in a minute to see the result.');
}

export async function confirmDevelopmentPayment(order: RazorpayOrder) {
  const res = await fetch('/api/payments/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.orderId, bookingId: order.bookingId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Payment confirmation failed.');
  return assertBookingIssued(body);
}

async function syncBookingPayment(bookingId: string) {
  const res = await fetch('/api/payments/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Payment confirmation failed.');
  return assertBookingIssued(body);
}

export async function payExistingOrder(
  order: RazorpayOrder & { provider: 'development' | 'razorpay' },
  opts: { name: string; description: string; prefillEmail?: string; prefillContact?: string; prefillName?: string },
) {
  if (order.provider === 'development') {
    return confirmDevelopmentPayment(order);
  }

  const paid = await openRazorpayCheckout(order, opts);
  try {
    return await confirmRazorpayPayment(paid);
  } catch (error) {
    try {
      return await syncBookingPayment(order.bookingId);
    } catch {
      throw error;
    }
  }
}

export async function completeBookingPayment(
  bookingId: string,
  opts: { name: string; description: string; prefillEmail?: string; prefillContact?: string; prefillName?: string },
) {
  const order = await createClientPaymentOrder(bookingId);
  const confirmed = await payExistingOrder(order, opts);
  return { order, confirmed };
}
