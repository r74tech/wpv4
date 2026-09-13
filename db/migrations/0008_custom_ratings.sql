PRAGMA foreign_keys = ON;

CREATE TABLE custom_rating_axes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL CONSTRAINT chk_custom_rating_axes_key CHECK (length(key) > 0),
    label TEXT NOT NULL,
    up_label TEXT,
    neutral_label TEXT,
    down_label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_custom_rating_axes_key ON custom_rating_axes (key);

CREATE TABLE custom_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    axis_id INTEGER NOT NULL REFERENCES custom_rating_axes(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    value INTEGER NOT NULL CONSTRAINT chk_custom_votes_value CHECK (value IN (-1, 0, 1)),
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_custom_votes_unique ON custom_votes (page_id, axis_id, user_id);
