import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, reconcileCart, type PendingCheckout } from '../src/lib/cart-reconcile';

const pending: PendingCheckout = { id: 'co-1', reference: 'GC-1', lines: [{ productId: 'A', quantity: 1 }, { productId: 'B', quantity: 2 }] };
const cart = [
  { productId: 'A', quantity: 1 },
  { productId: 'B', quantity: 2 },
  { productId: 'C', quantity: 1 }, // added after checkout started
];

test('server CONFIRMED removes exactly the paid lines; lines added later stay', () => {
  const r = reconcileCart(cart, pending, 'CONFIRMED');
  assert.deepEqual(r.items, [{ productId: 'C', quantity: 1 }]);
  assert.equal(r.outcome, 'paid');
  assert.equal(r.keepPending, false);
});

test('a line whose quantity changed after checkout started is not treated as paid', () => {
  const r = reconcileCart([{ productId: 'A', quantity: 3 }, { productId: 'B', quantity: 2 }], pending, 'CONFIRMED');
  assert.deepEqual(r.items, [{ productId: 'A', quantity: 3 }]);
});

test('anything other than CONFIRMED never removes cart lines', () => {
  for (const status of ['HELD', 'PAYMENT_PENDING', 'EXPIRED', 'CANCELLED', 'REFUND_REQUIRED', 'REFUNDED', undefined]) {
    assert.deepEqual(reconcileCart(cart, pending, status).items, cart, String(status));
  }
});

test('an open checkout stays remembered; finished ones are forgotten', () => {
  assert.equal(reconcileCart(cart, pending, 'PAYMENT_PENDING').keepPending, true);
  assert.equal(reconcileCart(cart, pending, 'HELD').keepPending, true);
  for (const status of ['CONFIRMED', 'REFUND_REQUIRED', 'REFUNDED', 'EXPIRED', 'CANCELLED']) {
    assert.equal(reconcileCart(cart, pending, status).keepPending, false, status);
  }
  assert.equal(outcomeOf('REFUNDED'), 'refunded');
  assert.equal(outcomeOf('EXPIRED'), 'closed');
});
