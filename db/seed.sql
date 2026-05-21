-- 開発用シードデータ
INSERT INTO pages (category, unix_name, title, source, revision_count) VALUES
('_default', 'main', 'Welcome', '+ Welcome to Wikitext Previewer v4

**Wikitext Previewer v4 (wpv4)** は Wikidot 互換の wikitext を編集・プレビューするための環境です。

[[toc]]

++ 使い方

+++ 1. サインイン

右上の「Sign in / Create account」から Wikidot (OAuth) または Passkey でサインインしてください。
未サインインではページ閲覧のみ可能です。

+++ 2. ページの作成

サインイン後、サイドバーに以下のリンクが出ます:

* **+ New public page** -- 完全公開ページ。誰でも閲覧、ListPages 掲載、include 可
* **+ New share page** -- URL を知っている人のみ閲覧、ListPages 非掲載、include 可（semi-public）
* **+ New private page** -- 作成者のみ閲覧、ListPages 非掲載、include 不可

クリックするとエディタが開きます。タイトルとソースを書いて **Save** で保存。
ULID が自動採番されて {{/public:<ULID>}}、{{/share:<ULID>}}、または {{/private:<ULID>}} に着地します。

+++ 3. ページの編集

ページ表示中、下部メニューに以下が出ます (権限がある場合):

* **Edit** -- ソース編集 (private = 作成者のみ、それ以外 = ログインユーザー全員)
* **Source** -- 現在のソース表示
* **History** -- リビジョン履歴。V (view) / S (source) で過去版を閲覧
* **Make public / Make share / Make private** -- 公開状態の切り替え (作成者のみ、現在の状態以外2つに切替)

+++ 4. 公開状態のトグル

public / share / private は ULID 不変で相互に切り替え可能 (URL の prefix だけ変わる)。
切替時に以下の影響が出る場合、他ページからの被 include を検出して警告:

* **target=private**: include が cannot-be-found 表示に変わる
* **public ↔ share**: ListPages 掲載状況が変わる (public のみ ListPages 掲載)

警告ダイアログで Force すれば強行できます。', 0),
('nav', 'side', 'Side Navigation', '* [[[main|Home]]]', 0),
('nav', 'top', 'Top Navigation', '* [[[main|Home]]]', 0);

-- 初期リビジョン
INSERT INTO revisions (page_id, revision_number, title, source, comment, visibility) VALUES
(1, 0, 'Welcome', '+ Welcome to Wikitext Previewer v4

**Wikitext Previewer v4 (wpv4)** は Wikidot 互換の wikitext を編集・プレビューするための環境です。

[[toc]]

++ 使い方

+++ 1. サインイン

右上の「Sign in / Create account」から Panopticon (OAuth) または Passkey でサインインしてください。
未サインインではページ閲覧のみ可能です。

+++ 2. ページの作成

サインイン後、サイドバーに以下のリンクが出ます:

* **+ New public page** -- 完全公開ページ。誰でも閲覧、ListPages に掲載、include 可
* **+ New share page** -- URL を知っている人のみ閲覧、ListPages 非掲載、include 可（semi-public）
* **+ New private page** -- 作成者のみ閲覧、ListPages 非掲載、include 不可

クリックするとエディタが開きます。タイトルとソースを書いて **Save** で保存。
ULID が自動採番されて {{/public:<ULID>}}、{{/share:<ULID>}}、または {{/private:<ULID>}} に着地します。

+++ 3. ページの編集

ページ表示中、下部メニューに以下が出ます (権限がある場合):

* **Edit** -- ソース編集 (private = 作成者のみ、それ以外 = ログインユーザー全員)
* **Source** -- 現在のソース表示
* **History** -- リビジョン履歴。V (view) / S (source) で過去版を閲覧
* **Make public / Make share / Make private** -- 公開状態の切り替え (作成者のみ、現在の状態以外2つに切替)

+++ 4. 公開状態のトグル

public / share / private は ULID 不変で相互に切り替え可能 (URL の prefix だけ変わる)。
切替時に以下の影響が出る場合、他ページからの被 include を検出して警告:

* **target=private**: include が cannot-be-found 表示に変わる
* **public ↔ share**: ListPages 掲載状況が変わる (public のみ ListPages 掲載)

警告ダイアログで Force すれば強行できます。', 'Initial page', 'share'),
(2, 0, 'Side Navigation', '* [[[main|Home]]]', 'Initial sidebar', 'share'),
(3, 0, 'Top Navigation', '* [[[main|Home]]]', 'Initial topbar', 'share');
