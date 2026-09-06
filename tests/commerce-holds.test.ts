/**
 * Commerce holds unit tests.
 *
 * Tests that require a live PostgreSQL database skip gracefully when
 * DATABASE_URL is absent (e.g. in CI without a DB service).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/errors';

const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// AppError shape — always runs (no DB needed)
// ---------------------------------------------------------------------------

test('AppError carries status and message', () => {
  const err = new AppError(409, 'Conflict');
  assert.equal(err.status, 409);
  assert.equal(err.message, 'Conflict');
  assert.ok(err instanceof Error);
});

test('AppError default code is INVALID_REQUEST', () => {
  const err = new AppError(400, 'Bad');
  assert.equal(err.code, 'INVALID_REQUEST');
});

test('AppError accepts custom code', () => {
  const err = new AppError(400, 'Bad', 'PRICE_CHANGED');
  assert.equal(err.code, 'PRICE_CHANGED');
});

// ---------------------------------------------------------------------------
// Idempotency key validation — pure logic (no DB needed)
// ---------------------------------------------------------------------------

test('reserve rejects idempotency key shorter than 8 chars', async () => {
  if (!DB_AVAILABLE) {
    // Import dynamically so missing DB env does not crash at module load
    const { reserve } = await import('../src/lib/commerce');
    const fakeUser = { id: 'user-1', contact: 'test@example.com', name: 'Test', role: 'customer' as const };
    await assert.rejects(
      () => reserve(fakeUser, { productId: 'p-1', quantity: 1, version: 1 }, 'short'),
      (err: unknown) => err instanceof AppError && err.status === 400 && /idempotency/i.test(err.message),
    );
  }
});

// ---------------------------------------------------------------------------
// DB-dependent tests — skipped when DATABASE_URL is absent
// ---------------------------------------------------------------------------

test('reserve requires product to exist (DB)', { skip: !DB_AVAILABLE }, async () => {
  const { reserve } = await import('../src/lib/commerce');
  const fakeUser = { id: 'user-1', contact: 'test@example.com', name: 'Test', role: 'customer' as const };
  await assert.rejects(
    () => reserve(fakeUser, { productId: '00000000-0000-0000-0000-000000000000', quantity: 1, version: 1 }, crypto.randomUUID()),
    (err: unknown) => err instanceof AppError && (err.status === 404 || err.status === 409),
  );
});

test('ownedBookings returns array for valid user (DB)', { skip: !DB_AVAILABLE }, async () => {
  const { ownedBookings } = await import('../src/lib/commerce');
  const result = await ownedBookings('00000000-0000-0000-0000-000000000001');
  assert.ok(Array.isArray(result));
});
