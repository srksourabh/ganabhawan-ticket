-- 0009: persistent account carts, verified mobile for email accounts, and a
-- notification delivery ledger. Additive only: new tables and nullable columns.
-- No existing row is changed. Reverse with db/rollback/0009_down.sql.

-- A verified mobile for accounts that sign in with email (mobile is mandatory to
-- buy). Set only after the customer proves the number with an SMS code
-- (account-contacts.ts); an account that signs in with its mobile uses users.contact.
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_mobile text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_mobile_unique ON users(verified_mobile) WHERE verified_mobile IS NOT NULL;

-- The signed-in customer's unpaid cart, kept on the server so it survives sign-out
-- and session expiry without ever being stored in the browser. Prices, versions and
-- availability are always read live from products; holds are still made only at checkout.
CREATE TABLE IF NOT EXISTS cart_items (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity int NOT NULL CHECK (quantity > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- Each browser guest cart merges into an account at most once (repeated sign-in
-- callbacks or two tabs cannot add its quantities twice).
CREATE TABLE IF NOT EXISTS cart_merges (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_cart_id text NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, guest_cart_id)
);

-- One row per notification actually accepted by the provider, keyed by its job key.
-- A retried job checks it first, so a message already sent is not sent again.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  key text PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  sent_at timestamptz NOT NULL DEFAULT now()
);
