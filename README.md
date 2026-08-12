# Wikitext Previewer v4

Wikidot サイトのフルモック的な wikitext 編集・プレビューツール。

- フレームワーク: Hono (SSR + API)
- レンダリング: @wdprlib/parser, @wdprlib/render (サーバー) / @wdprlib/runtime (クライアント)
- DB: Cloudflare D1 / Storage: Cloudflare R2
- 認証: Panopticon OAuth 2.0 + PKCE + Passkey
- デプロイ: Cloudflare Workers (Wrangler)

## ローカル開発

```bash
bun install

# DB 初期化（破壊的、既存ローカル D1 がある場合）
rm -rf .wrangler/state/v3/d1
bun run db:migrate
wrangler d1 execute wpv4-db --local --file db/seed.sql

# 開発サーバー起動
bun run dev
```

## 品質チェック

```bash
bun run typecheck                              # main / files worker
bunx tsc -p src/client/tsconfig.json --noEmit  # クライアント側
bun run lint
bun run format
bun run test
```

## デプロイ

Cloudflare **Workers Builds**（GitHub接続）でpushにより自動ビルド・デプロイする。main worker と files worker（html-block iframe・ユーザーアイコン配信）の2つを別プロジェクトとして接続する。files workerは共有D1でusernameをWikidot IDへ解決し、画像本体を専用R2から配信する。

### ブランチ戦略

| 環境 | ブランチ | main worker | files worker |
|------|---------|------------|-------------|
| development | (ローカル) | `wpv4-dev` | `wpfiles-dev` |
| preview / staging | `develop` (default) | `wpv4-staging.<account>.workers.dev` | `wpfiles-staging.<account>.workers.dev` |
| production | `production` | `wp.r74.tech` (custom domain) | `wpfiles.r74.workers.dev` |

`main` は使わない（GitHub default branch も `develop`）。production への deploy は明示的に `production` branch へ fast-forward push して発火させる方式。

### 初回セットアップ

1. **Cloudflare リソース作成**（手動）
   ```bash
   # staging
   wrangler d1 create wpv4-db-staging      # → database_id を wrangler.jsonc に転記
   wrangler r2 bucket create wpv4-files-staging
   wrangler r2 bucket create wpv4-avatars-staging
   # production
   wrangler d1 create wpv4-db-prd
   wrangler r2 bucket create wpv4-files-prd
   wrangler r2 bucket create wpv4-avatars-prd
   ```

2. **`wrangler.jsonc` の TODO を埋める**
   - `env.staging.d1_databases[0].database_id`
   - `env.production.d1_databases[0].database_id`

3. **D1 migration 適用（初回のみ、手動）**
   ```bash
   wrangler d1 migrations apply wpv4-db-staging --remote --env staging
   wrangler d1 migrations apply wpv4-db-prd --remote --env production
   ```

   既存ユーザーがいる環境では、avatar bucket作成後に一括投入する:
   ```bash
   bun scripts/backfill-user-avatars.ts staging
   bun scripts/backfill-user-avatars.ts production
   ```
   backfillはWikidotのprofile pageで現在のusernameとIDの対応を確認してから配信名を有効化する。改名などで一致しない既存rowはdefault表示のままにし、次回OAuthログイン時に更新する。既定avatarは一括投入でも保存され、空bucketではfiles Workerが内蔵画像を初回要求時に保存する。

4. **main worker を Workers Builds で接続**
   Cloudflare Dashboard → Workers & Pages → Create → Workers → **Connect to Git** で本リポジトリを選択し、以下を設定:
   - **Project name**: `wpv4`
   - **Production branch**: `production`
   - **Preview branch filter**: `develop` のみ許可（feature branch push でも staging を上書きされないようガード）
   - **Root directory**: `/`
   - **Build command**: `bun install --frozen-lockfile && bun run build`
   - **Deploy command**: `bunx wrangler deploy --env production`（`production` branch push 時）
   - **Preview deploy command**: `bunx wrangler deploy --env staging`（`develop` branch push 時のみ）
   - **Environment variables and Secrets** で main worker用に投入:
     - `CLIENT_SECRET` (Panopticon OAuth)
     - `SESSION_SECRET`

5. **files worker を Workers Builds で接続**
   同じく Connect to Git で別プロジェクト作成:
   - **Project name**: `wpfiles`
   - **Production branch**: `production`
   - **Preview branch filter**: `develop` のみ許可
   - **Root directory**: `/files-worker`
   - **Build command**: `bun install --frozen-lockfile`
   - **Deploy command**: `bunx wrangler deploy --env production`
   - **Preview deploy command**: `bunx wrangler deploy --env staging`（`develop` のみ）

6. **本番カスタムドメイン**を Cloudflare Dashboard → Workers & Pages → `wpv4-prd` → Settings → Domains & Routes で `wp.r74.tech` をバインド

### 通常のデプロイ

- `develop` push → 両プロジェクトの **Preview deployment** で staging に deploy
- `production` push → 両プロジェクトの **Production deployment** で production に deploy

production deploy は明示的に行う:
```bash
# develop の最新を production に fast-forward push でリリース
git fetch origin
git push origin origin/develop:production
```

（直接 production を checkout して merge してもよい。force-push は禁止）

D1 スキーマ変更時は migration を手動で先に適用:
```bash
wrangler d1 migrations apply wpv4-db-staging --remote --env staging
wrangler d1 migrations apply wpv4-db-prd --remote --env production
```

手動デプロイ（ローカル wrangler から）:
```bash
# main worker
bun run build
wrangler deploy --env staging       # or --env production
# files worker
cd files-worker && wrangler deploy --env staging  # or production
```

## 構成

```
wpv4/
├── src/                        # main worker (SSR + API)
│   ├── index.tsx
│   ├── routes/                 # /api/* + /auth/* + /user/*
│   ├── services/               # pipeline / nav / oauth / visibility-check
│   ├── lib/visibility.ts       # share/private/system 判定
│   ├── components/             # WikidotShell
│   ├── client/                 # ブラウザ側 main.ts / auth.ts
│   └── db/schema.ts            # Drizzle スキーマ
├── files-worker/               # html-block iframe・ユーザーアイコン配信 Worker
├── db/migrations/              # D1 migration SQL
├── public/                     # 静的アセット（html-block.css 等）
└── wrangler.jsonc              # main worker 設定（env.staging / env.production）
```
