/** Client-side Razorpay Checkout helper. Loads checkout.js once, then opens the modal. */

export type RazorpayOrder = {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  bookingId: string;
};

type RazorpaySuccess = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

type RazorpayConstructor = new (options: Record<string, unknown>) => { open: () => void };

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

export async function openRazorpayCheckout(
  order: RazorpayOrder,
  opts: { name: string; description: string; prefillEmail?: string },
): Promise<RazorpaySuccess> {
  await loadCheckoutScript();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error('Razorpay Checkout is unavailable.');

  return new Promise((resolve, reject) => {
    const rzp = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: opts.name,
      description: opts.description,
      order_id: order.orderId,
      prefill: opts.prefillEmail ? { email: opts.prefillEmail } : undefined,
      theme: { color: '#c9a227' },
      handler: (response: RazorpaySuccess) => resolve(response),
      modal: {
        ondismiss: () => reject(new Error('Payment cancelled.')),
      },
    });
    rzp.open();
  });
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
