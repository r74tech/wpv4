import { createMiddleware } from "hono/factory";
import type { AppEnv } from "@/types/env";

/**
 * 変更系リクエスト(PUT/POST/DELETE)のOriginヘッダーを検証する。
 * Content-Type: application/json も必須とし、formベースCSRFを排除する。
 */
export const verifyCsrf = createMiddleware<AppEnv>(async (c, next) => {
	const method = c.req.method;
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
		return next();
	}

	const origin = c.req.header("Origin");
	if (!origin) {
		return c.json({ error: "Missing Origin header" }, 403);
	}

	const requestUrl = new URL(c.req.url);
	const allowedOrigin = requestUrl.origin;
	if (origin !== allowedOrigin) {
		return c.json({ error: "Origin mismatch" }, 403);
	}

	const contentType = c.req.header("Content-Type");
	if (!contentType?.includes("application/json")) {
		return c.json({ error: "Content-Type must be application/json" }, 415);
	}

	return next();
});
