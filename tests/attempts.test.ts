import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/errors';
import { parseAttempt, summarizeMoney } from '../src/lib/attempts';

test('parseAttempt keeps a name, Indian mobile, and quantity', () => {
  const parsed = parseAttempt({
    name: '  Rina Das ',
    contact: '9876543210',
    productId: '11111111-1111-4111-8111-111111111111',
    quantity: 2,
  });
  assert.equal(parsed.name, 'Rina Das');
  assert.equal(parsed.contact, '+919876543210');
  assert.equal(parsed.quantity, 2);
});

test('parseAttempt rejects a blank name', () => {
  assert.throws(
    () => parseAttempt({ name: '  ', contact: 'rina@example.com', productId: '11111111-1111-4111-8111-111111111111', quantity: 1 }),
    (error: unknown) => error instanceof AppError && error.status === 400,
  );
});

test('summarizeMoney subtracts succeeded refunds from captured income', () => {
  assert.deepEqual(summarizeMoney(150000, 40000, 20000), {
    income: 150000,
    refunded: 40000,
    balance: 110000,
    pending: 20000,
  });
});
