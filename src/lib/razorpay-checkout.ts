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
        ondismiss: () => reject(new Error('Payment cancelled.')),
      },
    });
    rzp.on('payment.failed', (response) => {
      reject(new Error(response.error?.description || 'Payment failed.'));
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

export async function confirmRazorpayPayment(response: RazorpaySuccess) {
  const res = await fetch('/api/payments/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Payment confirmation failed.');
  return body;
}

export async function confirmDevelopmentPayment(order: RazorpayOrder) {
  const res = await fetch('/api/payments/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.orderId, bookingId: order.bookingId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Payment confirmation failed.');
  return body;
}

async function syncBookingPayment(bookingId: string) {
  const res = await fetch('/api/payments/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Payment confirmation failed.');
  return body;
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
