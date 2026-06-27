PRAGMA foreign_keys = ON;

-- page_tags is intended to be one row per (page_id, tag). Older data may have
-- stored multiple Wikidot tags in one row as whitespace/comma-separated text.

WITH RECURSIVE split(id, page_id, rest, token) AS (
    SELECT
        id,
        page_id,
        trim(
            replace(
                replace(
                    replace(
                        replace(tag, ',', ' '),
                        char(9), ' '
                    ),
                    char(10), ' '
                ),
                char(13), ' '
            )
        ) || ' ' AS rest,
        ''
    FROM page_tags
    UNION ALL
    SELECT
        id,
        page_id,
        ltrim(substr(rest, instr(rest, ' ') + 1)),
        trim(substr(rest, 1, instr(rest, ' ') - 1))
    FROM split
    WHERE rest != ''
)
INSERT OR IGNORE INTO page_tags (page_id, tag)
SELECT DISTINCT page_id, token
FROM split
WHERE token != '';

DELETE FROM page_tags
WHERE instr(tag, ' ') > 0
    OR instr(tag, ',') > 0
    OR instr(tag, char(9)) > 0
    OR instr(tag, char(10)) > 0
    OR instr(tag, char(13)) > 0;
