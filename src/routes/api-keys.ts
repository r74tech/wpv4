import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { API_KEY_SCOPES } from "@/lib/api-key";
import { verifyCsrf } from "@/middleware/csrf";
import { requireAuth } from "@/middleware/session";
import {
	createApiKey,
	deleteApiKey,
	listApiKeys,
	revokeApiKey,
	updateApiKey,
} from "@/services/api-keys";
import type { AppEnv } from "@/types/env";

const scopeSchema = z.enum(API_KEY_SCOPES);
const scopesSchema = z
	.array(scopeSchema)
	.min(1)
	.transform((scopes) => [...new Set(scopes)]);
const expirySchema = z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]);

const createSchema = z.object({
	name: z.string().trim().min(1).max(100),
	scopes: scopesSchema,
	expires_in_days: expirySchema,
});

const updateSchema = z
	.object({
		name: z.string().trim().min(1).max(100).optional(),
		scopes: scopesSchema.optional(),
	})
	.refine((value) => value.name !== undefined || value.scopes !== undefined);

function parseId(value: string): number | null {
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
}

const apiKeys = new Hono<AppEnv>();

apiKeys.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	return next();
});
apiKeys.use("*", verifyCsrf);
apiKeys.use("*", requireAuth);

apiKeys.get("/", async (c) => {
	const user = c.get("user")!;
	const keys = await listApiKeys(drizzle(c.env.DB), user.id);
	return c.json({
		keys: keys.map((key) => ({
			id: key.id,
			name: key.name,
			hint: key.hint,
			scopes: key.scopes,
			status: key.status,
			created_at: key.createdAt,
			last_used_at: key.lastUsedAt,
			expires_at: key.expiresAt,
			revoked_at: key.revokedAt,
		})),
	});
});

apiKeys.post("/", zValidator("json", createSchema), async (c) => {
	const user = c.get("user")!;
	const body = c.req.valid("json");
	const result = await createApiKey(drizzle(c.env.DB), {
		userId: user.id,
		name: body.name,
		scopes: body.scopes,
		expiresInDays: body.expires_in_days,
		now: new Date(),
	});
	if (!result.ok) {
		return c.json({ error: "Active API key limit reached", code: result.code }, 409);
	}
	return c.json(
		{
			id: result.id,
			key: result.plaintext,
			hint: result.hint,
			scopes: body.scopes,
			expires_at: result.expiresAt,
		},
		201,
	);
});

apiKeys.patch("/:id", zValidator("json", updateSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id === null) return c.json({ error: "Invalid API key id" }, 400);
	const user = c.get("user")!;
	const changed = await updateApiKey(drizzle(c.env.DB), user.id, id, c.req.valid("json"));
	if (changed === 0) return c.json({ error: "API key not found" }, 404);
	return c.json({ ok: true });
});

apiKeys.post("/:id/revoke", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id === null) return c.json({ error: "Invalid API key id" }, 400);
	const user = c.get("user")!;
	const changed = await revokeApiKey(drizzle(c.env.DB), user.id, id, new Date());
	if (changed === 0) return c.json({ error: "API key not found" }, 404);
	return c.json({ ok: true });
});

apiKeys.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id === null) return c.json({ error: "Invalid API key id" }, 400);
	const user = c.get("user")!;
	const changed = await deleteApiKey(drizzle(c.env.DB), user.id, id);
	if (changed === 0) return c.json({ error: "API key not found" }, 404);
	return c.json({ ok: true });
});

export { apiKeys };
