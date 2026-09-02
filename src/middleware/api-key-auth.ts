import { drizzle } from "drizzle-orm/d1";
import { createMiddleware } from "hono/factory";
import { hasScope, isApiKeyFormat, type ApiKeyScope } from "@/lib/api-key";
import { runInBackground } from "@/lib/background";
import { findActiveApiKey, touchApiKeyLastUsed } from "@/services/api-keys";
import type { AppEnv } from "@/types/env";

function unauthorized(c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0]) {
	c.header("WWW-Authenticate", 'Bearer realm="wpv4"');
	return c.json({ error: "Invalid or expired API key", code: "unauthorized" }, 401);
}

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.set("apiKey", null);
	c.set("user", null);
	const authorization = c.req.header("Authorization");
	if (!authorization?.startsWith("Bearer ")) return unauthorized(c);
	const plaintext = authorization.slice("Bearer ".length);
	if (!isApiKeyFormat(plaintext)) return unauthorized(c);

	const db = drizzle(c.env.DB);
	const key = await findActiveApiKey(db, plaintext, new Date());
	if (!key) return unauthorized(c);
	c.set("apiKey", {
		id: key.id,
		name: key.name,
		scopes: key.scopes,
		expiresAt: key.expiresAt,
	});
	c.set("user", key.user);
	await runInBackground(c, touchApiKeyLastUsed(db, key.id, new Date()));
	return next();
});

export function requireApiScope(scope: ApiKeyScope) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const key = c.get("apiKey");
		if (!key || !hasScope(key.scopes, scope)) {
			return c.json({ error: `Missing scope: ${scope}`, code: "insufficient_scope" }, 403);
		}
		return next();
	});
}
