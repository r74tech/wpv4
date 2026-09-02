PRAGMA foreign_keys = ON;

ALTER TABLE api_keys ADD COLUMN deleted_at TEXT;
