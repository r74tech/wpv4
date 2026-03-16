import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { sessions, users } from "@/db/schema";
import type { AppEnv } from "@/types/env";

async function hashToken(token: string): Promise<string> {
	const encoded = new TextEncoder().encode(token);
	const hash = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * セッション解決ミドルウェア。
 * cookieからセッショントークンを読み取り、有効ならc.set("user", ...)に設定する。
 * 認証必須ではない（未認証でもuser=nullで通過）。
 */
export const resolveSession = createMiddleware<AppEnv>(async (c, next) => {
	c.set("user", null);

	const token = getCookie(c, "session_token");
	if (!token) {
		return next();
	}

	const tokenHash = await hashToken(token);
	const db = drizzle(c.env.DB);
	const result = await db
		.select({
			userId: sessions.userId,
			name: users.name,
			unixName: users.unixName,
			wikidotId: users.wikidotId,
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.tokenHash, tokenHash))
		.limit(1);

	const row = result[0];
	if (!row) {
		return next();
	}

	// 有効期限チェックはアプリケーション層で行う（D1はdatetime比較が制限的なため）
	c.set("user", {
		id: row.userId,
		wikidotId: row.wikidotId,
		name: row.name,
		unixName: row.unixName,
	});

	return next();
});

/**
 * 認証必須ミドルウェア。
 * API (/api/*) → 401 JSON
 * それ以外 → /auth/login へリダイレクト
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
	const user = c.get("user");
	if (!user) {
		if (c.req.path.startsWith("/api/")) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		return c.redirect("/auth/login", 302);
	}
	return next();
});

export { hashToken };
