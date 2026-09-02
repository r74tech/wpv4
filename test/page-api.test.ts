import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { api } from "../src/routes/api";
import { changePageVisibility, deletePage } from "../src/services/page-ops";
import type { AppEnv, Bindings, Variables } from "../src/types/env";
import { applyMigrations, createD1 } from "./helpers/d1";

class EmptyR2 {
	async list(): Promise<{ objects: R2Object[]; truncated: false; delimitedPrefixes: string[] }> {
		return { objects: [], truncated: false, delimitedPrefixes: [] };
	}
}

function createEnv(
	sqlite: Database,
	r2: R2Bucket = new EmptyR2() as unknown as R2Bucket,
): Bindings {
	return {
		DB: createD1(sqlite),
		R2: r2,
		AVATARS: {} as R2Bucket,
		OAUTH_PROVIDER_URL: "",
		CLIENT_ID: "",
		CLIENT_SECRET: "",
		SESSION_SECRET: "test",
		FILES_DOMAIN: "https://files.example.com",
		FILES_URL_SECRET: "test",
	};
}

function createApp(user: Variables["user"]): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("user", user);
		return next();
	});
	app.route("/api", api);
	return app;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
	return {
		method,
		headers: { "Content-Type": "application/json", Origin: "http://localhost" },
		body: body === undefined ? undefined : JSON.stringify(body),
	};
}

async function createDatabase(): Promise<Database> {
	const sqlite = new Database(":memory:");
	await applyMigrations(sqlite);
	sqlite.run(
		"INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 10, 'Owner', 'owner'), (2, 20, 'Other', 'other')",
	);
	return sqlite;
}

describe("existing page API contract", () => {
	const databases: Database[] = [];
	afterEach(() => {
		for (const sqlite of databases.splice(0)) sqlite.close();
	});

	test("creates a page with revision zero and normalized tags", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const response = await createApp({
			id: 1,
			wikidotId: 10,
			name: "Owner",
			unixName: "owner",
		}).request(
			"http://localhost/api/web/page/new",
			jsonRequest("POST", {
				type: "share",
				title: "Draft",
				source: "hello",
				tags: ["alpha beta", "alpha"],
				comment: "initial",
			}),
			createEnv(sqlite),
		);
		const body = (await response.json()) as { path: string; html: string; styles: unknown[] };
		expect(response.status).toBe(200);
		expect(body.path).toMatch(/^share:[0-9a-z]{26}$/);
		expect(body).toEqual({ path: body.path, html: expect.any(String), styles: expect.any(Array) });
		expect(sqlite.query("SELECT revision_number, comment FROM revisions").get()).toEqual({
			revision_number: 0,
			comment: "initial",
		});
		expect(sqlite.query("SELECT tag FROM page_tags ORDER BY tag").all()).toEqual([
			{ tag: "alpha" },
			{ tag: "beta" },
		]);
	});

	test("preserves update conflict, lock, permission, and success responses", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		sqlite
			.query(
				"INSERT INTO pages (id, category, unix_name, title, source, revision_count, created_by) VALUES (1, 'private', ?, 'Old', 'old', 0, 1)",
			)
			.run(ulid);
		sqlite.run(
			"INSERT INTO revisions (page_id, revision_number, title, source, created_by) VALUES (1, 0, 'Old', 'old', 1)",
		);
		const owner = createApp({ id: 1, wikidotId: 10, name: "Owner", unixName: "owner" });
		const other = createApp({ id: 2, wikidotId: 20, name: "Other", unixName: "other" });
		const input = {
			title: "New",
			source: "new",
			tags: ["x"],
			comment: "edit",
			base_revision_number: 0,
		};

		expect(
			(
				await other.request(
					`http://localhost/api/web/page/private:${ulid}`,
					jsonRequest("PUT", input),
					createEnv(sqlite),
				)
			).status,
		).toBe(403);
		sqlite.run("UPDATE pages SET is_locked = 1 WHERE id = 1");
		expect(
			(
				await owner.request(
					`http://localhost/api/web/page/private:${ulid}`,
					jsonRequest("PUT", input),
					createEnv(sqlite),
				)
			).status,
		).toBe(403);
		sqlite.run("UPDATE pages SET is_locked = 0 WHERE id = 1");
		expect(
			(
				await owner.request(
					`http://localhost/api/web/page/private:${ulid}`,
					jsonRequest("PUT", { ...input, base_revision_number: 3 }),
					createEnv(sqlite),
				)
			).status,
		).toBe(409);

		const success = await owner.request(
			`http://localhost/api/web/page/private:${ulid}`,
			jsonRequest("PUT", input),
			createEnv(sqlite),
		);
		expect(success.status).toBe(200);
		expect(await success.json()).toEqual({ html: expect.any(String), styles: expect.any(Array) });
		expect(
			sqlite.query("SELECT title, source, revision_count FROM pages WHERE id = 1").get(),
		).toEqual({ title: "New", source: "new", revision_count: 1 });
	});

	test("preserves visibility conflict, success, and delete ownership", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		sqlite
			.query(
				"INSERT INTO pages (id, category, unix_name, title, source, revision_count, created_by) VALUES (1, 'share', ?, 'Draft', 'body', 0, 1)",
			)
			.run(ulid);
		const owner = createApp({ id: 1, wikidotId: 10, name: "Owner", unixName: "owner" });
		const other = createApp({ id: 2, wikidotId: 20, name: "Other", unixName: "other" });

		const mismatch = await owner.request(
			`http://localhost/api/web/page/${ulid}/visibility`,
			jsonRequest("POST", { target: "private", expected_category: "public", force: true }),
			createEnv(sqlite),
		);
		expect(mismatch.status).toBe(409);
		expect(await mismatch.json()).toEqual(expect.objectContaining({ actual_category: "share" }));

		const changed = await owner.request(
			`http://localhost/api/web/page/${ulid}/visibility`,
			jsonRequest("POST", { target: "private", expected_category: "share", force: true }),
			createEnv(sqlite),
		);
		expect(changed.status).toBe(200);
		expect(await changed.json()).toEqual({ ok: true, new_path: `private:${ulid}` });
		expect(
			(
				await other.request(
					`http://localhost/api/web/page/private:${ulid}`,
					jsonRequest("DELETE"),
					createEnv(sqlite),
				)
			).status,
		).toBe(403);
		expect(
			(
				await owner.request(
					`http://localhost/api/web/page/private:${ulid}`,
					jsonRequest("DELETE"),
					createEnv(sqlite),
				)
			).status,
		).toBe(200);
		expect(sqlite.query("SELECT deleted_by, deleted_at FROM pages").get()).toEqual({
			deleted_by: 1,
			deleted_at: expect.any(String),
		});
		expect(sqlite.query("SELECT count(*) AS count FROM revisions").get()).toEqual({ count: 1 });
	});

	test("does not delete after the page changes between authorization and update", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		sqlite
			.query(
				"INSERT INTO pages (id, category, unix_name, title, source, revision_count, created_by) VALUES (1, 'share', ?, 'Guide', 'body', 0, 1)",
			)
			.run(ulid);
		const base = createD1(sqlite) as unknown as {
			prepare(query: string): { bind(...params: unknown[]): Record<string, unknown> };
			batch(statements: unknown[]): Promise<unknown[]>;
		};
		let raced = false;
		const racingD1 = {
			prepare(query: string) {
				const prepared = base.prepare(query);
				return {
					bind(...params: unknown[]) {
						const bound = prepared.bind(...params) as {
							all(): Promise<unknown>;
							[key: string]: unknown;
						};
						return new Proxy(bound, {
							get(target, property, receiver) {
								if (property !== "all" && property !== "raw" && property !== "first") {
									return Reflect.get(target, property, receiver);
								}
								return async (...args: unknown[]) => {
									const method = Reflect.get(target, property, receiver) as (
										...values: unknown[]
									) => Promise<unknown>;
									const result = await method.apply(target, args);
									if (!raced) {
										raced = true;
										sqlite.run(
											"UPDATE pages SET category = 'private', revision_count = 1 WHERE id = 1",
										);
									}
									return result;
								};
							},
						});
					},
				};
			},
			batch: (statements: unknown[]) => base.batch(statements),
		} as unknown as D1Database;

		const result = await deletePage(drizzle(racingD1), {
			category: "share",
			unixName: ulid,
			userId: 1,
			now: new Date("2026-09-02T00:00:00.000Z"),
		});
		expect(result).toEqual({ ok: false, reason: "conflict" });
		expect(sqlite.query("SELECT category, revision_count, deleted_at FROM pages").get()).toEqual({
			category: "private",
			revision_count: 1,
			deleted_at: null,
		});
	});

	test("rolls back a private-to-public change when the R2 move fails", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		sqlite
			.query(
				"INSERT INTO pages (id, category, unix_name, title, source, revision_count, created_by) VALUES (1, 'private', ?, 'Draft', 'body', 0, 1)",
			)
			.run(ulid);
		const objects = new Map([[`private--html/${ulid}/hash`, "block"]]);
		const failingR2 = {
			async list({ prefix }: { prefix: string }) {
				return {
					objects: [...objects.keys()]
						.filter((key) => key.startsWith(prefix))
						.map((key) => ({ key })),
					truncated: false,
				};
			},
			async get(key: string) {
				const body = objects.get(key);
				return body === undefined ? null : { body, httpMetadata: {} };
			},
			async put(key: string) {
				if (key.startsWith("local--html/")) throw new Error("simulated R2 failure");
			},
			async delete(key: string) {
				objects.delete(key);
			},
		} as unknown as R2Bucket;
		const response = await createApp({
			id: 1,
			wikidotId: 10,
			name: "Owner",
			unixName: "owner",
		}).request(
			`http://localhost/api/web/page/${ulid}/visibility`,
			jsonRequest("POST", { target: "public", expected_category: "private", force: true }),
			createEnv(sqlite, failingR2),
		);

		expect(response.status).toBe(500);
		expect(sqlite.query("SELECT category, revision_count FROM pages WHERE id = 1").get()).toEqual({
			category: "private",
			revision_count: 2,
		});
		expect([...objects.entries()]).toEqual([[`private--html/${ulid}/hash`, "block"]]);
	});

	test("does not undo a concurrent successful visibility change", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		sqlite
			.query(
				"INSERT INTO pages (id, category, unix_name, title, source, revision_count, created_by) VALUES (1, 'public', ?, 'Draft', 'body', 0, 1)",
			)
			.run(ulid);
		const objects = new Map([[`local--html/${ulid}/hash`, "block"]]);
		let sourceDeletes = 0;
		let bothDeleted!: () => void;
		const bothSweepsReady = new Promise<void>((resolve) => (bothDeleted = resolve));
		const makeR2 = (gate: Promise<void>) =>
			({
				async list({ prefix }: { prefix: string }) {
					return {
						objects: [...objects.keys()]
							.filter((key) => key.startsWith(prefix))
							.map((key) => ({ key })),
						truncated: false,
					};
				},
				async get(key: string) {
					const body = objects.get(key);
					return body === undefined ? null : { body, httpMetadata: {} };
				},
				async put(key: string, body: string) {
					objects.set(key, body);
				},
				async delete(key: string) {
					objects.delete(key);
					if (key.startsWith("local--html/") && ++sourceDeletes === 2) bothDeleted();
					if (key.startsWith("local--html/")) await gate;
				},
			}) as unknown as R2Bucket;
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
		const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
		const input = {
			unixName: ulid,
			expectedCategory: "public" as const,
			target: "private" as const,
			force: true,
			userId: 1,
			now: new Date(),
			sleep: async () => {},
		};
		const first = changePageVisibility(drizzle(createD1(sqlite)), makeR2(firstGate), input);
		const second = changePageVisibility(drizzle(createD1(sqlite)), makeR2(secondGate), input);

		await bothSweepsReady;
		releaseFirst();
		const firstResult = await first;
		releaseSecond();
		const secondResult = await second;

		expect([firstResult.ok, secondResult.ok].sort()).toEqual([false, true]);
		expect(sqlite.query("SELECT category FROM pages WHERE id = 1").get()).toEqual({
			category: "private",
		});
		expect([...objects.keys()]).toEqual([`private--html/${ulid}/hash`]);
	});

	test("closes public HTML blocks when private rollback also fails", async () => {
		const sqlite = await createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		sqlite
			.query(
				"INSERT INTO pages (id, category, unix_name, title, source, revision_count, created_by) VALUES (1, 'public', ?, 'Draft', 'body', 0, 1)",
			)
			.run(ulid);
		const objects = new Map([[`local--html/${ulid}/original`, "original"]]);
		let listCalls = 0;
		let failed = false;
		const r2 = {
			async list({ prefix }: { prefix: string }) {
				listCalls += 1;
				if (listCalls === 2) {
					objects.set(`local--html/${ulid}/late-a`, "late-a");
					objects.set(`local--html/${ulid}/late-b`, "late-b");
				}
				return {
					objects: [...objects.keys()]
						.filter((key) => key.startsWith(prefix))
						.map((key) => ({ key })),
					truncated: false,
				};
			},
			async get(key: string) {
				const body = objects.get(key);
				return body === undefined ? null : { body, httpMetadata: {} };
			},
			async put(key: string, body: string) {
				if (key.endsWith("/late-b") && !failed) {
					failed = true;
					sqlite.run("UPDATE pages SET deleted_at = '2026-09-02T00:00:00.000Z' WHERE id = 1");
					throw new Error("simulated second sweep failure");
				}
				objects.set(key, body);
			},
			async delete(key: string) {
				objects.delete(key);
			},
		} as unknown as R2Bucket;

		const result = await changePageVisibility(drizzle(createD1(sqlite)), r2, {
			unixName: ulid,
			expectedCategory: "public",
			target: "private",
			force: true,
			userId: 1,
			now: new Date("2026-09-02T00:00:00.000Z"),
			sleep: async () => {},
		});
		expect(result).toEqual({ ok: false, reason: "internal" });
		expect(sqlite.query("SELECT category, deleted_at FROM pages").get()).toEqual({
			category: "private",
			deleted_at: "2026-09-02T00:00:00.000Z",
		});
		expect([...objects.keys()].some((key) => key.startsWith("local--html/"))).toBe(false);
		expect([...objects.keys()].sort()).toEqual([
			`private--html/${ulid}/late-a`,
			`private--html/${ulid}/late-b`,
			`private--html/${ulid}/original`,
		]);
	});
});
