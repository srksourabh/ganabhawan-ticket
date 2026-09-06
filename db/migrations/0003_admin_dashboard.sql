ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL;

ALTER TABLE festivals ADD COLUMN IF NOT EXISTS theater_photo text NOT NULL DEFAULT '/images/auditorium-ganabhawan.jpg';
