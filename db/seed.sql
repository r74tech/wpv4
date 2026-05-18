-- 開発用シードデータ
INSERT INTO pages (category, unix_name, title, source, revision_count) VALUES
('_default', 'main', 'Welcome', '+ Welcome to Wikitext Previewer v4

This is the **main page** of the Wikitext Previewer.

[[toc]]

++ Features

* Server-side rendering with WDPR
* Wikidot-compatible DOM structure
* Page editing and preview

++ Syntax Examples

//italic// **bold** __underline__ --strikethrough--

[[code]]
console.log("Hello, world!");
[[/code]]

> This is a blockquote.

[[collapsible show="+ Show more" hide="- Hide"]]
This is collapsible content.
[[/collapsible]]', 0),
('nav', 'side', 'Side Navigation', '* [[[main|Home]]]
* [[[nav:side|Sidebar]]]', 0),
('nav', 'top', 'Top Navigation', '* [[[main|Home]]]', 0);

-- 初期リビジョン
INSERT INTO revisions (page_id, revision_number, title, source, comment) VALUES
(1, 0, 'Welcome', '+ Welcome to Wikitext Previewer v4

This is the **main page** of the Wikitext Previewer.

[[toc]]

++ Features

* Server-side rendering with WDPR
* Wikidot-compatible DOM structure
* Page editing and preview

++ Syntax Examples

//italic// **bold** __underline__ --strikethrough--

[[code]]
console.log("Hello, world!");
[[/code]]

> This is a blockquote.

[[collapsible show="+ Show more" hide="- Hide"]]
This is collapsible content.
[[/collapsible]]', 'Initial page'),
(2, 0, 'Side Navigation', '* [[[main|Home]]]
* [[[nav:side|Sidebar]]]', 'Initial sidebar'),
(3, 0, 'Top Navigation', '* [[[main|Home]]]', 'Initial topbar');
