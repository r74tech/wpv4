import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { api } from "../src/routes/api";
import type { AppEnv, Bindings, Variables } from "../src/types/env";

type BoundStatement = {
	raw(): Promise<unknown[][]>;
	all(): Promise<{ results: Record<string, unknown>[] }>;
};

function createD1Adapter(sqlite: Database): D1Database {
	return {
		prepare(query: string) {
			return {
				bind(...params: unknown[]): BoundStatement {
					const statement = sqlite.query(query);
					return {
						raw: async () => statement.values(...params),
						all: async () => ({ results: statement.all(...params) }),
					};
				},
			};
		},
	} as unknown as D1Database;
}

function createDatabase(): Database {
	const sqlite = new Database(":memory:");
	sqlite.run(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			wikidot_id INTEGER NOT NULL,
			name TEXT NOT NULL,
			unix_name TEXT NOT NULL,
			created_at TEXT,
			last_login_at TEXT
		);
		CREATE TABLE pages (
			id INTEGER PRIMARY KEY,
			category TEXT NOT NULL,
			unix_name TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '',
			revision_count INTEGER DEFAULT 0,
			is_locked INTEGER NOT NULL DEFAULT 0,
			created_by INTEGER,
			updated_by INTEGER,
			created_at TEXT DEFAULT '2026-07-24T00:00:00.000Z',
			updated_at TEXT DEFAULT '2026-07-24T00:00:00.000Z'
		);
		CREATE TABLE page_tags (
			id INTEGER PRIMARY KEY,
			page_id INTEGER NOT NULL,
			tag TEXT NOT NULL
		);
		CREATE TABLE revisions (
			id INTEGER PRIMARY KEY,
			page_id INTEGER NOT NULL,
			revision_number INTEGER NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '',
			comment TEXT,
			visibility TEXT NOT NULL DEFAULT 'share',
			created_by INTEGER,
			created_at TEXT
		);
	`);
	return sqlite;
}

function createEnv(sqlite: Database): Bindings {
	return {
		DB: createD1Adapter(sqlite),
		R2: {} as R2Bucket,
		AVATARS: {} as R2Bucket,
		OAUTH_PROVIDER_URL: "",
		CLIENT_ID: "",
		CLIENT_SECRET: "",
		SESSION_SECRET: "",
		FILES_DOMAIN: "https://files.example.com/",
		FILES_URL_SECRET: "test-secret",
	};
}

function createTestApi(user: Variables["user"]): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("user", user);
		await next();
	});
	app.route("/api", api);
	return app;
}

describe("preview API page context", () => {
	const databases: Database[] = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	test("passes normalized path, tags, URL parameters, and authenticated viewer", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name, title, source, created_by) VALUES
				(1, 'private', '${ulid}', 'Private', 'OWNER_PRIVATE', 7),
				(2, '_default', 'alpha', 'Alpha', '', NULL),
				(3, '_default', 'beta', 'Beta', '', NULL);
		`);
		const app = createTestApi({ id: 7, wikidotId: 70, name: "Owner", unixName: "owner" });
		const response = await app.request(
			"http://localhost/api/preview",
			{
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "http://localhost" },
				body: JSON.stringify({
					source: [
						"[[image attachment.png]]",
						"[[iftags +visible]]MATCHED_TAG[[/iftags]]",
						'[[module ListPages order="titleAsc" offset="@URL|0" limit="1"]]',
						"URL_%%title%%",
						"[[/module]]",
						'[[module ListPages range="."]]',
						"SELF_%%content%%",
						"[[/module]]",
					].join("\n"),
					page_path: `private:${ulid.toUpperCase()}`,
					page_name: "legacy-name",
					category: "legacy-category",
					tags: [" visible, visible "],
					url_path: `/private:${ulid.toUpperCase()}/offset/1`,
				}),
			},
			createEnv(sqlite),
		);

		expect(response.status).toBe(200);
		const result = (await response.json()) as { html: string };
		expect(result.html).toContain(`/local--files/private:${ulid}/attachment.png`);
		expect(result.html).toContain("MATCHED_TAG");
		expect(result.html).toContain("URL_Beta");
		expect(result.html).toContain("SELF_OWNER_PRIVATE");
		expect(result.html).not.toContain("legacy-name");
	});

	test("returns current page tags with a revision", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (7, 70, 'Owner', 'owner');
			INSERT INTO pages (id, category, unix_name, title, source, created_by) VALUES
				(1, '_default', 'guide', 'Guide', 'current', 7);
			INSERT INTO revisions
				(id, page_id, revision_number, title, source, comment, visibility, created_by)
			VALUES (1, 1, 0, 'Old guide', 'old', 'initial', 'share', 7);
			INSERT INTO page_tags (id, page_id, tag) VALUES (1, 1, 'alpha'), (2, 1, 'beta');
		`);
		const app = createTestApi({ id: 7, wikidotId: 70, name: "Owner", unixName: "owner" });
		const response = await app.request(
			"http://localhost/api/page-revision/guide/r/0",
			undefined,
			createEnv(sqlite),
		);

		expect(response.status).toBe(200);
		const result = (await response.json()) as { page_path: string; tags: string[] };
		expect(result.page_path).toBe("_default:guide");
		expect(result.tags).toEqual(["alpha", "beta"]);
	});
});
