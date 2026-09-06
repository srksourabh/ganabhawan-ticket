import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGmailSendArguments, composioGmailConfigured } from '../src/lib/composio-gmail';

test('composioGmailConfigured requires API key plus account or user id', () => {
  const previous = {
    COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY,
    COMPOSIO_USER_ID: process.env.COMPOSIO_USER_ID,
    COMPOSIO_CONNECTED_ACCOUNT_ID: process.env.COMPOSIO_CONNECTED_ACCOUNT_ID,
  };
  try {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_USER_ID;
    delete process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;
    assert.equal(composioGmailConfigured(), false);

    process.env.COMPOSIO_API_KEY = 'test-key';
    process.env.COMPOSIO_CONNECTED_ACCOUNT_ID = 'ca_test';
    assert.equal(composioGmailConfigured(), true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Gmail send arguments match Composio GMAIL_SEND_EMAIL', () => {
  const previousFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'srksourabh@gmail.com';
  try {
    assert.deepEqual(buildGmailSendArguments('guest@example.com', 'Your Samatat Sanskriti sign-in code', 'Your code is 123456.'), {
      recipient_email: 'guest@example.com',
      subject: 'Your Samatat Sanskriti sign-in code',
      body: 'Your code is 123456.',
      is_html: false,
      user_id: 'me',
      from_email: 'srksourabh@gmail.com',
    });
  } finally {
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});
