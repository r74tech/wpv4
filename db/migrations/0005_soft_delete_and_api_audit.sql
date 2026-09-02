PRAGMA foreign_keys = ON;

ALTER TABLE pages ADD COLUMN deleted_by INTEGER REFERENCES users(id);
ALTER TABLE pages ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_pages_deleted_at ON pages(deleted_at);

CREATE TABLE IF NOT EXISTS api_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK(action IN ('page.create', 'page.update', 'page.delete', 'page.visibility')),
    page_id INTEGER REFERENCES pages(id),
    page_path TEXT NOT NULL,
	status_code INTEGER NOT NULL,
	response_json TEXT NOT NULL CHECK(json_valid(response_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_audit_events_key_id ON api_audit_events(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_audit_events_created_at ON api_audit_events(created_at);
