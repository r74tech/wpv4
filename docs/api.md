# wpv4 Page API

**Page API**は、外部ツールからwpv4のページを操作するためのJSON APIです。
外部向けのエンドポイントは`/api/v1`以下にあります。
ブラウザ内部の`/api/web`とは認証方式が異なり、CookieセッションではなくAPIキーを使用します。

## APIキーの発行と保管

1. wpv4へログインし、`/user/api-keys`を開きます。
2. APIキーの名前、有効期限、必要なスコープを選びます。
3. 「Create API key」を押し、モーダルに表示されたAPIキーを安全な場所へ保存します。

APIキーの平文を確認できるのは、作成直後の一度だけです。
データベースには、APIキーをSHA-256でハッシュ化した値だけを保存します。
有効期限を過ぎたAPIキーを使用すると、APIは`401`を返します。
管理画面では、有効期限を過ぎたAPIキーの状態を`expired`と表示します。

## スコープごとに許可される操作

**スコープ**は、APIキーに許可する操作の範囲です。

| スコープ           | 許可される操作                                                               |
| ------------------ | ---------------------------------------------------------------------------- |
| `pages:read`       | 所有するページの一覧と、閲覧できるページのメタデータ、ソース、タグを取得する |
| `pages:render`     | 閲覧できるページをレンダリングし、HTMLとスタイルを取得する                   |
| `pages:write`      | ページを作成し、編集できるページを更新する                                   |
| `pages:delete`     | 管理できるページを削除する                                                   |
| `pages:visibility` | ページの公開範囲を`public`、`share`、`private`の間で変更する                 |

スコープは、APIキーに許可された操作だけを制御します。
対象ページに対する権限は、APIキーを所有する利用者を基準に別途判定します。
`private`ページを取得または更新できるのは、そのページの所有者だけです。
`private`以外のページはすべての利用者が取得でき、ロックされていなければ更新できます。
削除と公開範囲の変更は、所有者が作成した`public`、`share`、`private`ページだけが対象です。

## Bearer認証の指定

**Bearer認証**は、HTTPリクエストの`Authorization`ヘッダーでAPIキーを送る認証方式です。
Page APIへのすべてのリクエストに、次のヘッダーを指定します。

```http
Authorization: Bearer wpv4_...
```

無効なAPIキー、取り消されたAPIキー、有効期限を過ぎたAPIキーには`401`を返します。
必要なスコープがAPIキーにない場合は`403`を返します。
Page APIのエラーレスポンスは、次の形式を基本とします。

```json
{ "error": "Page not found", "code": "not_found" }
```

## エラーコードの一覧

クライアントは、エラーの種類を`code`で判定できます。
リクエスト本文のフィールド検証に失敗した場合は、`validation`レスポンスに`issues`を含めます。

| コード                   | HTTPステータス | 発生条件                                                           |
| ------------------------ | -------------- | ------------------------------------------------------------------ |
| `unauthorized`           | `401`          | APIキーがない、形式が不正、取り消し済み、有効期限切れのいずれか    |
| `insufficient_scope`     | `403`          | APIキーに必要なスコープがない                                      |
| `forbidden`              | `403`          | 利用者に対象ページを取得または変更する権限がない                   |
| `locked`                 | `403`          | ロックされたページを変更しようとした                               |
| `validation`             | `400`          | JSONまたは入力フィールドが不正、または現在と同じ公開範囲を指定した |
| `not_found`              | `404`          | エンドポイント、ページ、ページパスのいずれかが見つからない         |
| `conflict`               | `409`          | リビジョンやカテゴリーの競合、または公開範囲変更による影響がある   |
| `payload_too_large`      | `413`          | JSONの本文が1,200,000バイトを超えた                                |
| `unsupported_media_type` | `415`          | 書き込みリクエストのContent-Typeが`application/json`ではない       |
| `internal`               | `500`          | サーバー内部の処理に失敗した                                       |

`render_failed`は、保存後のレンダリングだけが失敗したことを表します。
このコードは通常のエラーレスポンスではなく、成功レスポンスの`render_error.code`に入ります。

## 利用できるエンドポイント

| メソッド | パス                             | 必要なスコープ     | 操作                                               |
| -------- | -------------------------------- | ------------------ | -------------------------------------------------- |
| `GET`    | `/api/v1/me`                     | なし               | APIキーと利用者の情報を確認する                    |
| `GET`    | `/api/v1/pages`                  | `pages:read`       | 自分が作成したページの一覧を取得する               |
| `GET`    | `/api/v1/pages/:path`            | `pages:read`       | ページのメタデータ、ソース、タグを取得する         |
| `GET`    | `/api/v1/pages/:path/render`     | `pages:render`     | 保存済みページの`html`と`styles`をJSONで取得する   |
| `POST`   | `/api/v1/pages`                  | `pages:write`      | ページを作成し、メタデータ、`html`、`styles`を返す |
| `PUT`    | `/api/v1/pages/:path`            | `pages:write`      | ページを更新し、メタデータ、`html`、`styles`を返す |
| `DELETE` | `/api/v1/pages/:path`            | `pages:delete`     | ページを削除する                                   |
| `POST`   | `/api/v1/pages/:path/visibility` | `pages:visibility` | ページの公開範囲を変更する                         |

レスポンスには、データベース内部の数値IDを含めません。

## ページパスの形式

**ページパス**は、APIでページを識別する文字列です。
エンドポイントの`:path`には、`_default:guide`や`share:01arz3ndektsv4rrffq69g5fav`のように、カテゴリーとページ名をコロンでつないだ値を指定します。

## 書き込みリクエストの制約

`POST`と`PUT`のリクエストには、`Content-Type: application/json`を指定します。
JSON全体の上限は1,200,000バイトです。
ページの作成では`type`、`title`、`source`が必須です。
ページの更新では`title`、`source`、`base_revision_number`が必須です。
`tags`と`comment`は省略でき、既定値はそれぞれ空の配列と空文字列です。
更新時に`tags`を省略すると、既存のタグをすべて削除します。
公開範囲の変更では`target`が必須で、`force`の既定値は`false`です。

| フィールド     | 制約                                       |
| -------------- | ------------------------------------------ |
| `title`        | 128文字以下                                |
| `source`       | UTF-8で1,000,000バイト以下                 |
| `comment`      | 500文字以下                                |
| `tags`         | 入力配列と正規化後の配列がそれぞれ50件以下 |
| `tags`の各要素 | 128文字以下                                |

タグは各要素を空白とカンマで分割し、空の値と重複を取り除いてから保存します。

## APIキーと利用者の確認

次のリクエストは、APIキーと、そのキーを所有する利用者の情報を取得します。

```bash
export WPV4_API_URL="https://wp.r74.tech"
export WPV4_API_KEY="wpv4_..."

curl -sS "$WPV4_API_URL/api/v1/me" \
  -H "Authorization: Bearer $WPV4_API_KEY"
```

## ページの作成

次のリクエストは、公開範囲が`share`のページを作成します。

```bash
curl -sS "$WPV4_API_URL/api/v1/pages" \
  -H "Authorization: Bearer $WPV4_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "share",
    "title": "下書き",
    "source": "Draft text",
    "tags": ["draft"],
    "comment": "Initial draft"
  }'
```

作成のレスポンスには、保存結果のメタデータとレンダリング結果が含まれます。

```json
{
	"path": "share:PAGE_ULID",
	"category": "share",
	"unix_name": "PAGE_ULID",
	"revision_number": 0,
	"url": "https://wp.r74.tech/share:PAGE_ULID",
	"html": "<p>Draft text</p>",
	"styles": []
}
```

## 保存後にレンダリングだけが失敗した場合

保存に成功し、その後のレンダリングだけが失敗した場合も、`POST`は`201`を返し、`PUT`は`200`を返します。
この場合も、`path`と`revision_number`によって保存結果を識別できます。
レスポンスの`html`は`null`、`styles`は空の配列、`render_error.code`は`render_failed`になります。
保存したページは、レンダリング用のエンドポイントから再度レンダリングできます。

## リビジョン番号を使ったページの更新

更新前に`GET /api/v1/pages/:path`から`revision_number`を取得し、その値を`base_revision_number`に指定します。
別の更新が先に保存されている場合は、競合を示す`409`を返します。

```bash
curl -sS -X PUT "$WPV4_API_URL/api/v1/pages/share:PAGE_ULID" \
  -H "Authorization: Bearer $WPV4_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "title": "下書き v2",
    "source": "Updated draft",
    "tags": ["draft"],
    "comment": "Revise wording",
    "base_revision_number": 0
  }'
```

更新のレスポンスには、ページパス、更新後のリビジョン番号、レンダリング結果が含まれます。

```json
{
	"path": "share:PAGE_ULID",
	"revision_number": 1,
	"html": "<p>Updated draft</p>",
	"styles": []
}
```

## 保存済みページの再レンダリング

保存済みページを再レンダリングするには、このエンドポイントを使用します。
レスポンスはHTML文書ではなく、`html`と`styles`を含むJSONです。

```bash
curl -sS "$WPV4_API_URL/api/v1/pages/share:PAGE_ULID/render" \
  -H "Authorization: Bearer $WPV4_API_KEY"
```

## ページの公開範囲の変更

公開範囲を変更するときは、URL内のカテゴリーを現在値として競合を検出します。
includeやListPagesへの影響がある場合は`409`を返します。
このレスポンスには、参照元のページ、非表示になっている参照元の件数、includeが壊れるか、ListPagesの表示対象が変わるかを含めます。

```json
{
	"error": "Visibility change has notable impact",
	"code": "conflict",
	"referenced_by": [
		{
			"category": "public",
			"unix_name": "example-page",
			"title": "参照元のページ"
		}
	],
	"hidden_referenced_count": 0,
	"include_becomes_broken": true,
	"list_pages_presence_changes": true
}
```

影響を確認したうえで変更を続ける場合は、`force`に`true`を指定します。
URL内のカテゴリーが現在値と異なる場合は、`actual_category`を含む`409`を返します。
現在と同じ公開範囲を指定した場合は、`code`が`validation`の`400`を返します。

```bash
curl -sS -X POST "$WPV4_API_URL/api/v1/pages/share:PAGE_ULID/visibility" \
  -H "Authorization: Bearer $WPV4_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"target":"public","force":true}'
```
