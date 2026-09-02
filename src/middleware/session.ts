import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { sessions, users } from "@/db/schema";
import { sessionCookieName } from "@/lib/cookie";
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
 */
export const resolveSession = createMiddleware<AppEnv>(async (c, next) => {
	c.set("user", null);
	c.set("apiKey", null);
	if (c.req.path === "/api/v1" || c.req.path.startsWith("/api/v1/")) {
		return next();
	}

	const token = getCookie(c, sessionCookieName(c.req.url));
	if (!token) {
		return next();
	}

	const tokenHash = await hashToken(token);
	const db = drizzle(c.env.DB);

	const result = await db
		.select({
			userId: sessions.userId,
			expiresAt: sessions.expiresAt,
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

	// 有効期限チェック
	if (new Date(row.expiresAt) < new Date()) {
		await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
		return next();
	}

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
