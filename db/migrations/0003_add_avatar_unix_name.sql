ALTER TABLE users ADD COLUMN avatar_unix_name TEXT;

CREATE INDEX idx_users_avatar_unix_name ON users(avatar_unix_name);
