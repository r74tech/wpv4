PRAGMA foreign_keys = ON;

-- リビジョン時点のタグを JSON 配列で保持する。NULL はタグ未記録（本 migration 以前のリビジョン）
ALTER TABLE revisions ADD COLUMN tags TEXT CONSTRAINT chk_revisions_tags CHECK (tags IS NULL OR json_valid(tags));

-- 最新リビジョンだけは現在のタグと一致するため埋める
UPDATE revisions
SET tags = (
    SELECT json_group_array(tag)
    FROM (SELECT tag FROM page_tags WHERE page_tags.page_id = revisions.page_id ORDER BY id)
)
WHERE revision_number = (SELECT revision_count FROM pages WHERE pages.id = revisions.page_id);
