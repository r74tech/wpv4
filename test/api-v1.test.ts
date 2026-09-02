import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { ApiKeyScope } from "../src/lib/api-key";
import { projectAuditResponse } from "../src/middleware/api-audit";
import { api } from "../src/routes/api";
import { createApiKey } from "../src/services/api-keys";
import type { AppEnv, Bindings } from "../src/types/env";
import { applyMigrations, createD1 } from "./helpers/d1";

class EmptyR2 {
	async list(): Promise<{ objects: R2Object[]; truncated: false; delimitedPrefixes: string[] }> {
		return { objects: [], truncated: false, delimitedPrefixes: [] };
	}
}

function createEnv(sqlite: Database): Bindings {
	return {
		DB: createD1(sqlite),
		R2: new EmptyR2() as unknown as R2Bucket,
		AVATARS: {} as R2Bucket,
		OAUTH_PROVIDER_URL: "",
		CLIENT_ID: "",
		CLIENT_SECRET: "",
		SESSION_SECRET: "test",
		FILES_DOMAIN: "https://files.example.com",
		FILES_URL_SECRET: "test",
	};
}

function createApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.route("/api", api);
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

async function issueKey(
	sqlite: Database,
	scopes: ApiKeyScope[],
	expiresInDays: 30 | 90 | 365 | null = 30,
): Promise<string> {
	const result = await createApiKey(drizzle(createD1(sqlite)), {
		userId: 1,
		name: "test",
		scopes,
		expiresInDays,
		now: new Date("2026-09-02T00:00:00.000Z"),
	});
	if (!result.ok) throw new Error("key creation failed");
	return result.plaintext;
}

function request(key: string | null, method = "GET", body?: unknown): RequestInit {
	return {
		method,
		headers: {
			...(key ? { Authorization: `Bearer ${key}` } : {}),
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	};
}

describe("external API v1", () => {
	const databases: Database[] = [];
	afterEach(() => {
		for (const sqlite of databases.splice(0)) sqlite.close();
	});

	test("projects audit responses onto non-sensitive bounded fields", () => {
		expect(
			projectAuditResponse({
				id: 1,
				path: "share:page",
				error: "Conflict",
				code: "conflict",
				source: "secret source",
				html: "<p>large</p>",
				key: "wpv4_secret",
				referenced_by: [{ title: "many references" }],
				issues: [{ message: "raw validation details" }],
			}),
		).toEqual({ path: "share:page", error: "Conflict", code: "conflict" });
	});

	test("requires Bearer auth, ignores old routes, and enforces render separately from read", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const key = await issueKey(sqlite, ["pages:read"]);
		sqlite.run(
			"INSERT INTO pages (id, category, unix_name, title, source, created_by) VALUES (1, '_default', 'guide', 'Guide', 'hello', 1)",
		);
		const app = createApp();
		const env = createEnv(sqlite);

		const unauthorized = await app.request("http://localhost/api/v1/me", request(null), env);
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("WWW-Authenticate")).toContain("Bearer");
		const me = await app.request("http://localhost/api/v1/me", request(key), env);
		expect(me.status).toBe(200);
		expect(await me.json()).toEqual({
			user: { wikidot_id: 10, name: "Owner", unix_name: "owner" },
			key: {
				name: "test",
				scopes: ["pages:read"],
				expires_at: "2026-10-02T00:00:00.000Z",
			},
		});
		expect((await app.request("http://localhost/api/v1/pages", request(key), env)).status).toBe(
			200,
		);
		expect(
			(await app.request("http://localhost/api/v1/pages/_default:guide/render", request(key), env))
				.status,
		).toBe(403);
		const deniedWrite = await app.request(
			"http://localhost/api/v1/pages",
			request(key, "POST", { type: "share", title: "No", source: "No" }),
			env,
		);
		expect(deniedWrite.status).toBe(403);
		const deniedAudit = sqlite
			.query("SELECT status_code, response_json FROM api_audit_events")
			.get() as { status_code: number; response_json: string };
		expect(deniedAudit.status_code).toBe(403);
		expect(JSON.parse(deniedAudit.response_json)).toEqual({
			error: "Missing scope: pages:write",
			code: "insufficient_scope",
		});
		expect(
			(await app.request("http://localhost/api/page/_default:guide", request(key), env)).status,
		).toBe(404);
	});

	test("rejects extra path suffixes without applying a page operation", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const key = await issueKey(sqlite, ["pages:read", "pages:write", "pages:delete"]);
		sqlite.run(
			"INSERT INTO pages (id, category, unix_name, title, source, created_by) VALUES (1, '_default', 'guide', 'Guide', 'hello', 1)",
		);
		const app = createApp();
		const env = createEnv(sqlite);
		const updateBody = {
			title: "Wrong",
			source: "wrong",
			tags: [],
			base_revision_number: 0,
		};
		expect(
			(
				await app.request(
					"http://localhost/api/v1/pages/_default:guide/render/extra",
					request(key),
					env,
				)
			).status,
		).toBe(404);
		expect(
			(
				await app.request(
					"http://localhost/api/v1/pages/_default:guide/visibility",
					request(key, "PUT", updateBody),
					env,
				)
			).status,
		).toBe(404);
		expect(
			(
				await app.request(
					"http://localhost/api/v1/pages/_default:guide/render",
					request(key, "DELETE"),
					env,
				)
			).status,
		).toBe(404);
		expect(sqlite.query("SELECT deleted_at, title FROM pages WHERE id = 1").get()).toEqual({
			deleted_at: null,
			title: "Guide",
		});
	});

	test("enforces body and normalized tag limits", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const key = await issueKey(sqlite, ["pages:write"]);
		const app = createApp();
		const env = createEnv(sqlite);
		const tooManyTags = Array.from({ length: 51 }, (_, index) => `tag${index}`).join(" ");
		const tagsResponse = await app.request(
			"http://localhost/api/v1/pages",
			request(key, "POST", { type: "share", title: "Tags", source: "x", tags: [tooManyTags] }),
			env,
		);
		expect(tagsResponse.status).toBe(400);

		const oversized = new TextEncoder().encode("x".repeat(1_200_001));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(oversized);
				controller.close();
			},
		});
		const oversizedRequest = new Request("http://localhost/api/v1/pages", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit);
		const oversizedResponse = await app.request(oversizedRequest, undefined, env);
		expect(oversizedResponse.status).toBe(413);
		expect(sqlite.query("SELECT count(*) AS count FROM pages").get()).toEqual({ count: 0 });
	});

	test("returns an identifiable saved result when post-write rendering fails", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const key = await issueKey(sqlite, ["pages:write"]);
		const env = createEnv(sqlite);
		env.R2 = {
			head: async () => null,
			put: async () => {
				throw new Error("simulated render persistence failure");
			},
			delete: async () => {},
		} as unknown as R2Bucket;
		const response = await createApp().request(
			"http://localhost/api/v1/pages",
			request(key, "POST", {
				type: "share",
				title: "Saved",
				source: "[[html]]<p>block</p>[[/html]]",
				tags: [],
			}),
			env,
		);
		expect(response.status).toBe(201);
		const result = (await response.json()) as Record<string, unknown>;
		expect(result).toEqual(
			expect.objectContaining({
				path: expect.stringMatching(/^share:/),
				revision_number: 0,
				html: null,
				styles: [],
				render_error: {
					code: "render_failed",
					message: "The page was saved, but rendering failed",
				},
			}),
		);
		expect(sqlite.query("SELECT title, deleted_at FROM pages").get()).toEqual({
			title: "Saved",
			deleted_at: null,
		});
		const audit = sqlite
			.query("SELECT page_id, page_path, status_code, response_json FROM api_audit_events")
			.get() as { page_id: number; page_path: string; status_code: number; response_json: string };
		expect(audit.page_id).toBe(1);
		expect(audit.page_path).toBe(result.path);
		expect(audit.status_code).toBe(201);
		expect(JSON.parse(audit.response_json)).toEqual(
			expect.objectContaining({ path: result.path, render_error: result.render_error }),
		);
	});

	test("creates, reads, renders, updates, changes visibility, soft-deletes, and audits responses", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const key = await issueKey(sqlite, [
			"pages:read",
			"pages:render",
			"pages:write",
			"pages:delete",
			"pages:visibility",
		]);
		const app = createApp();
		const env = createEnv(sqlite);
		const createdResponse = await app.request(
			"http://localhost/api/v1/pages",
			request(key, "POST", {
				type: "share",
				title: "Draft",
				source: "hello",
				tags: ["alpha beta"],
				comment: "initial",
			}),
			env,
		);
		expect(createdResponse.status).toBe(201);
		const created = (await createdResponse.json()) as {
			path: string;
			html: string;
			styles: string[];
		};
		expect(created.path).toMatch(/^share:[0-9a-z]{26}$/);
		expect(created).toEqual(
			expect.objectContaining({ html: expect.any(String), styles: expect.any(Array) }),
		);
		expect(created).not.toHaveProperty("id");
		const pageId = (
			sqlite.query("SELECT id FROM pages WHERE unix_name = ?").get(created.path.split(":")[1]) as {
				id: number;
			}
		).id;

		const read = await app.request(
			`http://localhost/api/v1/pages/${created.path}`,
			request(key),
			env,
		);
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual(
			expect.objectContaining({ source: "hello", tags: ["alpha", "beta"] }),
		);
		const rendered = await app.request(
			`http://localhost/api/v1/pages/${created.path}/render`,
			request(key),
			env,
		);
		expect(rendered.status).toBe(200);
		expect(await rendered.json()).toEqual(
			expect.objectContaining({ html: expect.any(String), styles: expect.any(Array) }),
		);

		const updated = await app.request(
			`http://localhost/api/v1/pages/${created.path}`,
			request(key, "PUT", {
				title: "Updated",
				source: "updated",
				tags: ["next"],
				comment: "edit",
				base_revision_number: 0,
			}),
			env,
		);
		expect(updated.status).toBe(200);
		expect(await updated.json()).toEqual(
			expect.objectContaining({
				path: created.path,
				revision_number: 1,
				html: expect.any(String),
				styles: expect.any(Array),
			}),
		);

		const ulid = created.path.split(":")[1];
		const visibility = await app.request(
			`http://localhost/api/v1/pages/${created.path}/visibility`,
			request(key, "POST", { target: "private", force: true }),
			env,
		);
		expect(visibility.status).toBe(200);
		const privatePath = `private:${ulid}`;
		expect(await visibility.json()).toEqual(
			expect.objectContaining({ path: privatePath, revision_number: 2 }),
		);

		const deleted = await app.request(
			`http://localhost/api/v1/pages/${privatePath}`,
			request(key, "DELETE"),
			env,
		);
		expect(deleted.status).toBe(200);
		const deletedBody = await deleted.json();
		expect(deletedBody).toEqual(
			expect.objectContaining({
				path: privatePath,
				deleted_at: expect.any(String),
			}),
		);
		expect(
			(await app.request(`http://localhost/api/v1/pages/${privatePath}`, request(key), env)).status,
		).toBe(404);
		expect(
			sqlite.query("SELECT deleted_by, deleted_at FROM pages WHERE id = ?").get(pageId),
		).toEqual({
			deleted_by: 1,
			deleted_at: expect.any(String),
		});
		expect(
			sqlite.query("SELECT count(*) AS count FROM revisions WHERE page_id = ?").get(pageId),
		).toEqual({ count: 3 });
		expect(
			sqlite.query("SELECT count(*) AS count FROM page_tags WHERE page_id = ?").get(pageId),
		).toEqual({ count: 1 });

		const auditRows = sqlite
			.query("SELECT action, page_id, status_code, response_json FROM api_audit_events ORDER BY id")
			.all() as Array<{
			action: string;
			page_id: number | null;
			status_code: number;
			response_json: string;
		}>;
		expect(auditRows.map(({ action }) => action)).toEqual([
			"page.create",
			"page.update",
			"page.visibility",
			"page.delete",
		]);
		expect(auditRows.every(({ page_id }) => page_id === pageId)).toBe(true);
		expect(JSON.parse(auditRows.at(-1)!.response_json)).toEqual(deletedBody);
		expect(auditRows.at(-1)!.status_code).toBe(200);
		for (const row of auditRows) {
			expect(row.response_json).not.toContain('"html"');
			expect(row.response_json).not.toContain('"styles"');
		}
	});
});
