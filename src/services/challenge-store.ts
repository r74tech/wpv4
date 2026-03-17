import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";

/**
 * サーバーサイドのchallenge/stateストア。
 * D1のauth_stateテーブルに短命データを保存し、Cookie注入攻撃を防ぐ。
 * クライアントにはキー（ランダムUUID）のみをcookieで渡す。
 */

export async function storeChallenge(
	db: D1Database,
	data: Record<string, string>,
	ttlSeconds = 300,
): Promise<string> {
	const key = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
	const d = drizzle(db);
	await d.run(
		sql`INSERT INTO auth_state (key, data, expires_at) VALUES (${key}, ${JSON.stringify(data)}, ${expiresAt})`,
	);
	return key;
}

/**
 * challengeを原子的に取得・削除する（DELETE ... RETURNING で1クエリ）。
 * 並行リクエストによるリプレイを防止。
 */
export async function consumeChallenge(
	db: D1Database,
	key: string,
): Promise<Record<string, string> | null> {
	const d = drizzle(db);

	// DELETE ... RETURNING で原子的に取得+削除
	const result = await d.all<{ data: string; expires_at: string }>(
		sql`DELETE FROM auth_state WHERE key = ${key} RETURNING data, expires_at`,
	);

	const row = result[0];
	if (!row) return null;

	// 有効期限チェック
	if (new Date(row.expires_at) < new Date()) return null;

	return JSON.parse(row.data);
}

/**
 * 期限切れエントリの掃除（リクエスト時に低確率で実行）
 */
export async function cleanupExpiredState(db: D1Database): Promise<void> {
	const d = drizzle(db);
	await d.run(sql`DELETE FROM auth_state WHERE expires_at < datetime('now')`);
}
