CREATE TABLE booking_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  contact text NOT NULL,
  name text NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity int NOT NULL CHECK (quantity > 0),
  outcome text NOT NULL DEFAULT 'STARTED' CHECK (outcome IN ('STARTED','HELD','CONFIRMED','FAILED')),
  booking_id uuid REFERENCES bookings(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_attempts_recent ON booking_attempts(created_at DESC);
CREATE INDEX booking_attempts_contact ON booking_attempts(contact, created_at DESC);
