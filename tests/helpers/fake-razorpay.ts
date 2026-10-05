/**
 * In-process stand-in for the Razorpay REST API (and Resend email), installed
 * over globalThis.fetch. It enforces the provider rules the app relies on:
 * one capture per payment, refunds never exceeding the captured amount,
 * notes echoed back. `latencyMs` widens race windows in concurrency tests.
 *
 * This is NOT a substitute for the real test-mode drill (scripts/razorpay-drill.ts).
 */
import { randomBytes } from 'node:crypto';

type Order = { id: string; amount: number; currency: string; receipt: string; status: string; notes: Record<string, string> };
type Payment = { id: string; order_id: string; amount: number; currency: string; status: string };
type Refund = { id: string; payment_id: string; amount: number; status: string; notes: Record<string, string> };

const id = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeRazorpay {
  orders = new Map<string, Order>();
  payments = new Map<string, Payment>();
  refunds = new Map<string, Refund>();
  calls: string[] = [];
  emails: { to: string; subject: string; text: string }[] = [];
  latencyMs = 0;
  /** Status Razorpay reports for a newly created refund. */
  refundStatus: 'processed' | 'pending' | 'failed' = 'processed';
  failEmail = false;
  down = false;
  private original?: typeof fetch;

  install() {
    this.original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => this.handle(String(input instanceof Request ? input.url : input), init)) as typeof fetch;
    return this;
  }

  uninstall() {
    if (this.original) globalThis.fetch = this.original;
  }

  reset() {
    this.orders.clear(); this.payments.clear(); this.refunds.clear(); this.calls = []; this.emails = [];
    this.latencyMs = 0; this.refundStatus = 'processed'; this.failEmail = false; this.down = false;
  }

  /** Customer pays an order in the checkout modal. */
  pay(orderId: string, opts: { status?: 'captured' | 'authorized' | 'failed'; amount?: number } = {}) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('fake: unknown order ' + orderId);
    const payment: Payment = { id: id('pay'), order_id: orderId, amount: opts.amount ?? order.amount, currency: order.currency, status: opts.status ?? 'captured' };
    this.payments.set(payment.id, payment);
    if (payment.status === 'captured') order.status = 'paid';
    return payment;
  }

  count(prefix: string) {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith('https://api.resend.com/')) {
      this.calls.push(`${method} resend`);
      if (this.failEmail) return json({ message: 'provider down' }, 503);
      const body = JSON.parse(String(init?.body ?? '{}'));
      this.emails.push({ to: body.to?.[0], subject: body.subject, text: body.text });
      return json({ id: id('email') });
    }
    if (!url.startsWith('https://api.razorpay.com/v1/')) throw new Error('fake fetch: unexpected URL ' + url);
    const path = url.slice('https://api.razorpay.com/v1'.length);
    this.calls.push(`${method} ${path.replace(/[a-z]+_[0-9a-f]{14}/g, ':id')}`);
    if (this.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    if (this.down) return json({ error: { description: 'Service unavailable' } }, 503);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let m: RegExpMatchArray | null;

    if (method === 'POST' && path === '/orders') {
      const order: Order = { id: id('order'), amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created', notes: body.notes ?? {} };
      this.orders.set(order.id, order);
      return json(order);
    }
    if (method === 'GET' && (m = path.match(/^\/orders\?receipt=([^&]+)/))) {
      const receipt = decodeURIComponent(m[1]);
      return json({ items: [...this.orders.values()].filter((o) => o.receipt === receipt) });
    }
    if (method === 'GET' && (m = path.match(/^\/orders\/([^/]+)\/payments$/))) {
      return json({ items: [...this.payments.values()].filter((p) => p.order_id === m![1]) });
    }
    if (method === 'GET' && (m = path.match(/^\/payments\/([^/]+)$/))) {
      const payment = this.payments.get(m[1]);
      return payment ? json(payment) : json({ error: { description: 'not found' } }, 404);
    }
    if (method === 'POST' && (m = path.match(/^\/payments\/([^/]+)\/capture$/))) {
      const payment = this.payments.get(m[1]);
      if (!payment || payment.status !== 'authorized') return json({ error: { description: 'This payment has already been captured' } }, 400);
      payment.status = 'captured';
      return json(payment);
    }
    if (method === 'GET' && (m = path.match(/^\/payments\/([^/]+)\/refunds$/))) {
      return json({ items: [...this.refunds.values()].filter((r) => r.payment_id === m![1]) });
    }
    if (method === 'POST' && (m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
      const payment = this.payments.get(m[1]);
      if (!payment || payment.status !== 'captured') return json({ error: { description: 'payment not captured' } }, 400);
      const already = [...this.refunds.values()].filter((r) => r.payment_id === payment.id && r.status !== 'failed').reduce((sum, r) => sum + r.amount, 0);
      if (already + body.amount > payment.amount) return json({ error: { description: 'The refund amount exceeds the captured amount' } }, 400);
      const refund: Refund = { id: id('rfnd'), payment_id: payment.id, amount: body.amount, status: this.refundStatus, notes: body.notes ?? {} };
      this.refunds.set(refund.id, refund);
      return json(refund);
    }
    if (method === 'GET' && (m = path.match(/^\/refunds\/([^/]+)$/))) {
      const refund = this.refunds.get(m[1]);
      return refund ? json(refund) : json({ error: { description: 'not found' } }, 404);
    }
    throw new Error(`fake razorpay: unhandled ${method} ${path}`);
  }
}
