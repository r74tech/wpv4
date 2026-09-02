import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { apiKeys } from "../src/routes/api-keys";
import type { AppEnv, Bindings } from "../src/types/env";
import { applyMigrations, createD1 } from "./helpers/d1";

function createEnv(sqlite: Database): Bindings {
	return {
		DB: createD1(sqlite),
		R2: {} as R2Bucket,
		AVATARS: {} as R2Bucket,
		OAUTH_PROVIDER_URL: "",
		CLIENT_ID: "",
		CLIENT_SECRET: "",
		SESSION_SECRET: "test",
		FILES_DOMAIN: "",
		FILES_URL_SECRET: "",
	};
}

function createApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		const id = Number(c.req.header("X-Test-User"));
		c.set(
			"user",
			Number.isInteger(id) && id > 0
				? { id, wikidotId: id * 10, name: `User ${id}`, unixName: `user-${id}` }
				: null,
		);
		return next();
	});
	app.route("/api/web/api-keys", apiKeys);
	return app;
}

async function createDatabase(): Promise<Database> {
	const sqlite = new Database(":memory:");
	await applyMigrations(sqlite);
	sqlite.run(
		"INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 10, 'Owner', 'owner'), (2, 20, 'Other', 'other')",
	);
	return sqlite;
}

function requestJson(
	app: Hono<AppEnv>,
	env: Bindings,
	path: string,
	method: string,
	body?: unknown,
	user = 1,
) {
	const routePath = path === "/" ? "" : path;
	return app.request(
		`http://localhost/api/web/api-keys${routePath}`,
		{
			method,
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost",
				...(user > 0 ? { "X-Test-User": String(user) } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		},
		env,
	);
}

describe("API key management API", () => {
	test("requires CSRF and a cookie-authenticated user", async () => {
		const sqlite = await createDatabase();
		try {
			const app = createApp();
			const env = createEnv(sqlite);
			const missingOrigin = await app.request(
				"http://localhost/api/web/api-keys",
				{
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: "Bearer wpv4_fake" },
					body: "{}",
				},
				env,
			);
			expect(missingOrigin.status).toBe(403);
			const noUser = await requestJson(app, env, "/", "POST", {}, 0);
			expect(noUser.status).toBe(401);
		} finally {
			sqlite.close();
		}
	});

	test("creates a key once and never returns its secret from the list", async () => {
		const sqlite = await createDatabase();
		try {
			const app = createApp();
			const env = createEnv(sqlite);
			const createdResponse = await requestJson(app, env, "/", "POST", {
				name: "Claude",
				scopes: ["pages:read", "pages:write", "pages:read"],
				expires_in_days: 90,
			});
			const created = (await createdResponse.json()) as { id: number; key: string };
			expect(createdResponse.status).toBe(201);
			expect(created.key).toMatch(/^wpv4_/);

			const listResponse = await app.request(
				"http://localhost/api/web/api-keys",
				{ headers: { "X-Test-User": "1" } },
				env,
			);
			const text = await listResponse.text();
			expect(listResponse.headers.get("Cache-Control")).toBe("no-store");
			expect(text).not.toContain(created.key);
			expect(JSON.parse(text)).toEqual({
				keys: [
					expect.objectContaining({
						id: created.id,
						name: "Claude",
						scopes: ["pages:read", "pages:write"],
						status: "active",
					}),
				],
			});
		} finally {
			sqlite.close();
		}
	});

	test("updates, revokes, and deletes only the owner's key", async () => {
		const sqlite = await createDatabase();
		try {
			const app = createApp();
			const env = createEnv(sqlite);
			const createdResponse = await requestJson(app, env, "/", "POST", {
				name: "Claude",
				scopes: ["pages:read"],
				expires_in_days: null,
			});
			const created = (await createdResponse.json()) as { id: number };

			expect(
				(await requestJson(app, env, `/${created.id}`, "PATCH", { name: "Other" }, 2)).status,
			).toBe(404);
			expect(
				(
					await requestJson(app, env, `/${created.id}`, "PATCH", {
						name: "Agent",
						scopes: ["pages:write"],
					})
				).status,
			).toBe(200);
			expect((await requestJson(app, env, `/${created.id}/revoke`, "POST", {})).status).toBe(200);
			expect((await requestJson(app, env, `/${created.id}/revoke`, "POST", {})).status).toBe(404);
			const activeResponse = await requestJson(app, env, "/", "POST", {
				name: "Active",
				scopes: ["pages:read"],
				expires_in_days: null,
			});
			const active = (await activeResponse.json()) as { id: number };
			expect((await requestJson(app, env, `/${active.id}`, "DELETE")).status).toBe(200);
			const deleted = sqlite
				.query("SELECT revoked_at, deleted_at FROM api_keys WHERE id = ?")
				.get(active.id) as { revoked_at: string | null; deleted_at: string | null };
			expect(deleted.revoked_at).not.toBeNull();
			expect(deleted.deleted_at).not.toBeNull();
			expect((await requestJson(app, env, `/${active.id}`, "DELETE")).status).toBe(404);
			const listResponse = await app.request(
				"http://localhost/api/web/api-keys",
				{ headers: { "X-Test-User": "1" } },
				env,
			);
			expect(await listResponse.json()).toEqual({
				keys: [expect.objectContaining({ id: created.id, status: "revoked" })],
			});
		} finally {
			sqlite.close();
		}
	});

	test("rejects empty and unknown scopes", async () => {
		const sqlite = await createDatabase();
		try {
			const app = createApp();
			const env = createEnv(sqlite);
			for (const scopes of [[], ["unknown"]]) {
				const response = await requestJson(app, env, "/", "POST", {
					name: "Bad",
					scopes,
					expires_in_days: 30,
				});
				expect(response.status).toBe(400);
			}
		} finally {
			sqlite.close();
		}
	});
});
