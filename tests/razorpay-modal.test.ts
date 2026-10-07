/**
 * Staging report (Oct 2026): a successful Razorpay TEST payment left the cart
 * showing "Continue to payment". Razorpay Checkout is opened with retry
 * enabled, so after a failed attempt the modal stays open and the customer can
 * pay again. The browser must still receive that later success.
 * These tests drive openRazorpayCheckout with a stand-in for checkout.js.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openRazorpayCheckout, type RazorpayOrder } from '../src/lib/razorpay-checkout';

type Handler = (payload: Record<string, unknown>) => void;
type Script = (modal: { fail: (description: string) => void; succeed: () => void; dismiss: () => void }) => void;

function installModal(script: Script) {
  class FakeRazorpay {
    private failed: Handler[] = [];
    constructor(private readonly options: { handler: Handler; modal?: { ondismiss?: () => void } }) {}
    on(event: string, cb: Handler) { if (event === 'payment.failed') this.failed.push(cb); }
    open() {
      setTimeout(() => script({
        fail: (description) => this.failed.forEach((cb) => cb({ error: { description } })),
        succeed: () => this.options.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_ok', razorpay_signature: 'sig' }),
        dismiss: () => this.options.modal?.ondismiss?.(),
      }), 0);
    }
  }
  (globalThis as unknown as { window: unknown }).window = { Razorpay: FakeRazorpay, location: { origin: 'https://tickets.test' } };
}

afterEach(() => { delete (globalThis as unknown as { window?: unknown }).window; });

const order = { provider: 'razorpay', orderId: 'order_1', amount: 75000, currency: 'INR', keyId: 'rzp_test_x', bookingId: 'co_1' } as RazorpayOrder;
const opts = { name: 'Festival', description: '2 ticket types' };

test('a failed attempt followed by a successful retry in the same modal resolves with the success', async () => {
  installModal((m) => { m.fail('Card declined'); m.succeed(); });
  const paid = await openRazorpayCheckout(order, opts);
  assert.equal(paid.razorpay_payment_id, 'pay_ok');
});

test('a plain success resolves', async () => {
  installModal((m) => m.succeed());
  assert.equal((await openRazorpayCheckout(order, opts)).razorpay_payment_id, 'pay_ok');
});

test('closing the modal without paying rejects as cancelled', async () => {
  installModal((m) => m.dismiss());
  await assert.rejects(() => openRazorpayCheckout(order, opts), /cancelled/i);
});

test('failing and then closing the modal rejects with the failure reason (not a silent hang)', async () => {
  installModal((m) => { m.fail('Card declined'); m.dismiss(); });
  await assert.rejects(() => openRazorpayCheckout(order, opts), /Card declined/);
});
