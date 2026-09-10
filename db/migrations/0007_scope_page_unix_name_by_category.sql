PRAGMA defer_foreign_keys = ON;

CREATE TABLE pages_0007_sequence (seq INTEGER NOT NULL);
INSERT INTO pages_0007_sequence
SELECT max(
    coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'pages'), 0),
    coalesce(max(id), 0)
)
FROM pages;

CREATE TABLE pages_0007_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    unix_name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    revision_count INTEGER DEFAULT 0,
    is_locked INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_by INTEGER REFERENCES users(id),
    deleted_at TEXT
);

INSERT INTO pages_0007_new (
    id,
    category,
    unix_name,
    title,
    source,
    revision_count,
    is_locked,
    created_by,
    updated_by,
    created_at,
    updated_at,
    deleted_by,
    deleted_at
)
SELECT
    id,
    category,
    unix_name,
    title,
    source,
    revision_count,
    is_locked,
    created_by,
    updated_by,
    created_at,
    updated_at,
    deleted_by,
    deleted_at
FROM pages;

CREATE TABLE revisions_0007_backup AS SELECT * FROM revisions;
CREATE TABLE page_tags_0007_backup AS SELECT * FROM page_tags;
CREATE TABLE votes_0007_backup AS SELECT * FROM votes;

DROP TABLE pages;
ALTER TABLE pages_0007_new RENAME TO pages;
UPDATE sqlite_sequence
SET seq = max(seq, (SELECT seq FROM pages_0007_sequence))
WHERE name = 'pages';
INSERT INTO sqlite_sequence(name, seq)
SELECT 'pages', seq
FROM pages_0007_sequence
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'pages');

INSERT INTO revisions SELECT * FROM revisions_0007_backup;
INSERT INTO page_tags SELECT * FROM page_tags_0007_backup;
INSERT INTO votes SELECT * FROM votes_0007_backup;

DROP TABLE revisions_0007_backup;
DROP TABLE page_tags_0007_backup;
DROP TABLE votes_0007_backup;
DROP TABLE pages_0007_sequence;

CREATE UNIQUE INDEX idx_pages_category_unix_name ON pages(category, unix_name);
CREATE UNIQUE INDEX idx_pages_managed_unix_name
ON pages(unix_name)
WHERE category IN ('public', 'share', 'private');
CREATE INDEX idx_pages_category ON pages(category);
CREATE INDEX idx_pages_deleted_at ON pages(deleted_at);

CREATE TRIGGER trg_pages_managed_unix_name_insert
BEFORE INSERT ON pages
WHEN EXISTS (
    SELECT 1
    FROM pages
    WHERE unix_name = NEW.unix_name
      AND (
          NEW.category IN ('public', 'share', 'private')
          OR category IN ('public', 'share', 'private')
      )
)
BEGIN
    SELECT RAISE(ABORT, 'managed page unix_name must be globally unique');
END;

CREATE TRIGGER trg_pages_managed_unix_name_update
BEFORE UPDATE OF category, unix_name ON pages
WHEN EXISTS (
    SELECT 1
    FROM pages
    WHERE id <> OLD.id
      AND unix_name = NEW.unix_name
      AND (
          NEW.category IN ('public', 'share', 'private')
          OR category IN ('public', 'share', 'private')
      )
)
BEGIN
    SELECT RAISE(ABORT, 'managed page unix_name must be globally unique');
END;

PRAGMA defer_foreign_keys = OFF;
