import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  razorpayCheckoutDigest,
  razorpayWebhookDigest,
  signaturesMatch,
} from '../src/lib/razorpay';

test('checkout signature is HMAC-SHA256 of order_id|payment_id', () => {
  const secret = 'test_secret';
  const orderId = 'order_ABC';
  const paymentId = 'pay_XYZ';
  const signature = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  assert.equal(razorpayCheckoutDigest(orderId, paymentId, secret), signature);
  assert.equal(signaturesMatch(signature, signature), true);
});

test('forged checkout signature does not match', () => {
  const expected = razorpayCheckoutDigest('order_ABC', 'pay_XYZ', 'test_secret');
  const forged = razorpayCheckoutDigest('order_ABC', 'pay_TAMPERED', 'test_secret');
  assert.equal(signaturesMatch(expected, forged), false);
});

test('webhook signature is HMAC-SHA256 of the raw body', () => {
  const secret = 'whsec_test';
  const rawBody = '{"event":"payment.captured"}';
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  assert.equal(razorpayWebhookDigest(rawBody, secret), signature);
  assert.equal(signaturesMatch(signature, signature), true);
  assert.equal(signaturesMatch(signature, razorpayWebhookDigest('{"event":"other"}', secret)), false);
});
