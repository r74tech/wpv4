import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../src/types/env";

mock.module("client-manifest-data", () => ({ default: {} }));

const { auth } = await import("../src/routes/auth");

function createDatabase(): Database {
	const sqlite = new Database(":memory:");
	sqlite.run(`
		CREATE TABLE auth_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at TEXT NOT NULL);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			wikidot_id INTEGER NOT NULL UNIQUE,
			name TEXT NOT NULL,
			unix_name TEXT NOT NULL,
			avatar_unix_name TEXT,
			created_at TEXT,
			last_login_at TEXT
		);
		CREATE TABLE sessions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			token_hash TEXT NOT NULL UNIQUE,
			user_id INTEGER NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT
		);
	`);
	return sqlite;
}

function createD1(sqlite: Database): D1Database {
	return {
		prepare(query: string) {
			return {
				bind(...params: unknown[]) {
					const statement = sqlite.query(query);
					return {
						all: async () => ({ results: statement.all(...params) }),
						raw: async () => statement.values(...params),
						run: async () => {
							const result = statement.run(...params);
							return {
								success: true,
								results: [],
								meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
							};
						},
					};
				},
			};
		},
		async batch(statements: D1PreparedStatement[]) {
			sqlite.run("BEGIN");
			try {
				const results = [];
				for (const statement of statements) results.push(await statement.all());
				sqlite.run("COMMIT");
				return results;
			} catch (error) {
				sqlite.run("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
}

describe("OAuth avatar provisioning", () => {
	test("creates the session when avatar storage fails after user creation", async () => {
		const sqlite = createDatabase();
		const originalFetch = globalThis.fetch;
		const originalConsoleError = console.error;
		globalThis.fetch = async () => Response.json({ id: 4053112, name: "User", unix_name: "user" });
		console.error = () => {};
		try {
			insertChallenge(sqlite);
			const app = new Hono<AppEnv>().route("/", auth);
			const response = await app.request(
				"http://localhost/callback?code=code&state=state",
				{ headers: { Cookie: "oauth_state=challenge" } },
				createEnv(sqlite),
			);

			expect(response.status).toBe(302);
			expect(sqlite.query("SELECT unix_name, avatar_unix_name FROM users").get()).toEqual({
				unix_name: "user",
				avatar_unix_name: "user",
			});
			expect(sqlite.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
			expect(response.headers.get("Set-Cookie")).toContain("last_login_method=");
		} finally {
			globalThis.fetch = originalFetch;
			console.error = originalConsoleError;
			sqlite.close();
		}
	});

	test("keeps the immutable avatar key when a user is renamed", async () => {
		const sqlite = createDatabase();
		sqlite.run(
			"INSERT INTO users (wikidot_id, name, unix_name, avatar_unix_name) VALUES (4053112, 'User', 'old-user', 'old-user')",
		);
		const originalFetch = globalThis.fetch;
		const originalConsoleError = console.error;
		globalThis.fetch = async () =>
			Response.json({ id: 4053112, name: "User", unix_name: "new-user" });
		console.error = () => {};
		const heads: string[] = [];
		try {
			insertChallenge(sqlite);
			const app = new Hono<AppEnv>().route("/", auth);
			const response = await app.request(
				"http://localhost/callback?code=code&state=state",
				{ headers: { Cookie: "oauth_state=challenge" } },
				createEnv(sqlite, {
					async head(key: string) {
						heads.push(key);
						return { key } as R2Object;
					},
				} as R2Bucket),
			);

			expect(response.status).toBe(302);
			expect(sqlite.query("SELECT unix_name, avatar_unix_name FROM users").get()).toEqual({
				unix_name: "new-user",
				avatar_unix_name: "new-user",
			});
			expect(heads).toEqual(["users/4053112/avatar"]);
		} finally {
			globalThis.fetch = originalFetch;
			console.error = originalConsoleError;
			sqlite.close();
		}
	});

	test("reassigns only avatar ownership when OAuth confirms a reused username", async () => {
		const sqlite = createDatabase();
		sqlite.run(
			"INSERT INTO users (wikidot_id, name, unix_name, avatar_unix_name) VALUES (1, 'Old', 'shared-name', 'shared-name')",
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => Response.json({ id: 2, name: "New", unix_name: "shared-name" });
		try {
			insertChallenge(sqlite);
			const app = new Hono<AppEnv>().route("/", auth);
			const response = await app.request(
				"http://localhost/callback?code=code&state=state",
				{ headers: { Cookie: "oauth_state=challenge" } },
				createEnv(sqlite, {
					async head(key: string) {
						return { key } as R2Object;
					},
				} as R2Bucket),
			);

			expect(response.status).toBe(302);
			expect(
				sqlite
					.query("SELECT wikidot_id, unix_name, avatar_unix_name FROM users ORDER BY wikidot_id")
					.all(),
			).toEqual([
				{ wikidot_id: 1, unix_name: "shared-name", avatar_unix_name: null },
				{ wikidot_id: 2, unix_name: "shared-name", avatar_unix_name: "shared-name" },
			]);
		} finally {
			globalThis.fetch = originalFetch;
			sqlite.close();
		}
	});

	test("rolls back avatar ownership when the current user insert fails", async () => {
		const sqlite = createDatabase();
		sqlite.run(
			"INSERT INTO users (wikidot_id, name, unix_name, avatar_unix_name) VALUES (1, 'Old', 'shared-name', 'shared-name')",
		);
		sqlite.run(`
			CREATE TRIGGER reject_user BEFORE INSERT ON users
			WHEN NEW.wikidot_id = 2
			BEGIN
				SELECT RAISE(FAIL, 'rejected user');
			END
		`);
		const originalFetch = globalThis.fetch;
		const originalConsoleError = console.error;
		globalThis.fetch = async () => Response.json({ id: 2, name: "New", unix_name: "shared-name" });
		console.error = () => {};
		try {
			insertChallenge(sqlite);
			const app = new Hono<AppEnv>().route("/", auth);
			const response = await app.request(
				"http://localhost/callback?code=code&state=state",
				{ headers: { Cookie: "oauth_state=challenge" } },
				createEnv(sqlite),
			);

			expect(response.status).toBe(500);
			expect(sqlite.query("SELECT wikidot_id, avatar_unix_name FROM users").get()).toEqual({
				wikidot_id: 1,
				avatar_unix_name: "shared-name",
			});
		} finally {
			globalThis.fetch = originalFetch;
			console.error = originalConsoleError;
			sqlite.close();
		}
	});
});

function insertChallenge(sqlite: Database): void {
	sqlite
		.query("INSERT INTO auth_state (key, data, expires_at) VALUES (?, ?, ?)")
		.run(
			"challenge",
			JSON.stringify({ state: "state", codeVerifier: "verifier", type: "oauth" }),
			"2099-01-01T00:00:00.000Z",
		);
}

function createEnv(
	sqlite: Database,
	avatars: R2Bucket = {
		async head() {
			throw new Error("R2 unavailable");
		},
	} as R2Bucket,
): Bindings {
	return {
		DB: createD1(sqlite),
		R2: {} as R2Bucket,
		AVATARS: avatars,
		OAUTH_PROVIDER_URL: "https://oauth.example.com",
		CLIENT_ID: "client",
		CLIENT_SECRET: "secret",
		SESSION_SECRET: "session-secret",
		FILES_DOMAIN: "https://files.example.com",
		FILES_URL_SECRET: "files-secret",
	};
}
