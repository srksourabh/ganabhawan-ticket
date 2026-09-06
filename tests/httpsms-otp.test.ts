import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContact } from '../src/lib/security';
import { buildHttpsmsPayload, httpsmsConfigured, httpsmsEnabled, otpProvider } from '../src/lib/httpsms';

test('normalizeContact accepts Indian 10-digit mobiles as +91', () => {
  assert.equal(normalizeContact('9876543210'), '+919876543210');
  assert.equal(normalizeContact('09876543210'), '+919876543210');
  assert.equal(normalizeContact('91 98765 43210'), '+919876543210');
  assert.equal(normalizeContact('+91 98765 43210'), '+919876543210');
});

test('normalizeContact still requires a valid international number for other countries', () => {
  assert.equal(normalizeContact('+18005550199'), '+18005550199');
  assert.throws(() => normalizeContact('12345'), /country code/);
});

test('normalizeContact lowercases email', () => {
  assert.equal(normalizeContact('Fest@Example.COM'), 'fest@example.com');
});

test('httpsms payload matches the official send API', () => {
  const previousFrom = process.env.HTTPSMS_FROM;
  process.env.HTTPSMS_FROM = '+919111222333';
  try {
    assert.deepEqual(buildHttpsmsPayload('+919876543210', 'Samatat Sanskriti code: 123456. Valid 5 min. Do not share.', 'req-1'), {
      from: '+919111222333',
      to: '+919876543210',
      content: 'Samatat Sanskriti code: 123456. Valid 5 min. Do not share.',
      encrypted: false,
      request_id: 'req-1',
    });
  } finally {
    if (previousFrom === undefined) delete process.env.HTTPSMS_FROM;
    else process.env.HTTPSMS_FROM = previousFrom;
  }
});

test('httpsmsEnabled follows OTP_PROVIDER=httpsms or configured keys', () => {
  const previousProvider = process.env.OTP_PROVIDER;
  const previousKey = process.env.HTTPSMS_API_KEY;
  const previousFrom = process.env.HTTPSMS_FROM;
  try {
    process.env.OTP_PROVIDER = 'development';
    delete process.env.HTTPSMS_API_KEY;
    delete process.env.HTTPSMS_FROM;
    assert.equal(otpProvider(), 'development');
    assert.equal(httpsmsConfigured(), false);
    assert.equal(httpsmsEnabled(), false);

    process.env.OTP_PROVIDER = 'httpsms';
    assert.equal(httpsmsEnabled(), true);

    process.env.OTP_PROVIDER = 'development';
    process.env.HTTPSMS_API_KEY = 'test-key';
    process.env.HTTPSMS_FROM = '+919111222333';
    assert.equal(httpsmsConfigured(), true);
    assert.equal(httpsmsEnabled(), true);
  } finally {
    if (previousProvider === undefined) delete process.env.OTP_PROVIDER;
    else process.env.OTP_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.HTTPSMS_API_KEY;
    else process.env.HTTPSMS_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.HTTPSMS_FROM;
    else process.env.HTTPSMS_FROM = previousFrom;
  }
});
