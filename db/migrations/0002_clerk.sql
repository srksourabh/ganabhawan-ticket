-- Clerk identity bridge for Google OAuth (and other Clerk providers).
ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_id text UNIQUE;
CREATE INDEX IF NOT EXISTS users_clerk_id ON users(clerk_id) WHERE clerk_id IS NOT NULL;
