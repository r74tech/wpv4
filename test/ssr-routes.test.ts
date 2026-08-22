import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { rememberLastLoginMethod, type LastLoginMethod } from "../src/lib/last-login-method";
import type { AppEnv, Bindings } from "../src/types/env";
import { hashToken } from "../src/middleware/session";

mock.module("client-manifest-data", () => ({ default: {} }));

const { default: app } = await import("../src/index");

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
			wikidot_id INTEGER NOT NULL UNIQUE,
			name TEXT NOT NULL,
			unix_name TEXT NOT NULL,
			created_at TEXT,
			last_login_at TEXT
		);
		CREATE TABLE sessions (
			id INTEGER PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			user_id INTEGER NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT
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
			created_at TEXT,
			updated_at TEXT
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
		CREATE TABLE passkeys (
			id INTEGER PRIMARY KEY,
			user_id INTEGER NOT NULL,
			credential_id TEXT NOT NULL UNIQUE,
			public_key TEXT NOT NULL,
			counter INTEGER NOT NULL DEFAULT 0,
			device_type TEXT,
			backed_up INTEGER NOT NULL DEFAULT 0,
			transports TEXT,
			name TEXT NOT NULL DEFAULT '',
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
		SESSION_SECRET: "test-session-secret",
		FILES_DOMAIN: "https://files.example.com/",
		FILES_URL_SECRET: "test-files-secret",
	};
}

async function createLastLoginCookie(
	env: Bindings,
	lastLoginMethod: LastLoginMethod,
): Promise<string> {
	const cookieApp = new Hono<AppEnv>().get("/", async (c) => {
		await rememberLastLoginMethod(c, lastLoginMethod);
		return c.body(null);
	});
	const response = await cookieApp.request("http://localhost/", undefined, env);
	return response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
}

describe("route-level SSR shell state", () => {
	const sqlite = createDatabase();
	const env = createEnv(sqlite);
	const sessionToken = "valid-session-token";

	beforeAll(async () => {
		const tokenHash = await hashToken(sessionToken);
		sqlite
			.prepare(
				"INSERT INTO users (id, wikidot_id, name, unix_name, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(7, 70, "Owner", "owner", "2026-01-01T00:00:00.000Z");
		sqlite
			.prepare("INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)")
			.run(1, tokenHash, 7, "2099-01-01T00:00:00.000Z");
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name, title, source, created_by) VALUES
				(1, '_default', 'main', 'Main', '', 7),
				(2, 'private', '01arz3ndektsv4rrffq69g5fav', 'Private', 'secret', 7);
		`);
	});

	afterAll(() => sqlite.close());

	const authenticatedHeaders = { Cookie: `session=${sessionToken}` };

	test("renders authenticated UI and page actions for an empty normal page", async () => {
		const response = await app.request("http://localhost/", { headers: authenticatedHeaders }, env);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('<div id="page-content"></div>');
		expect(html).toContain('<span class="printuser avatarhover">');
		expect(html).toContain('src="https://files.example.com/avatar?userId=70"');
		expect(html).toContain('data-files-domain="https://files.example.com"');
		expect(html).toContain('<a href="/new?type=public">+ Public</a>');
		expect(html).toContain('data-action="edit" data-path="main"');
		expect(html).toContain('data-action="source" data-path="main"');
		expect(html).not.toContain('data-action="toggle-visibility"');
	});

	test("renders signed-out UI without page actions for a 404", async () => {
		const response = await app.request("http://localhost/missing", undefined, env);
		const html = await response.text();

		expect(response.status).toBe(404);
		expect(html).toContain('id="login-link"');
		expect(html).toContain('data-files-domain="https://files.example.com"');
		expect(html).toContain("<p>Account</p>");
		expect(html).not.toContain('data-action="source"');
	});

	test("renders signed-out UI without page actions for a 403", async () => {
		const response = await app.request(
			"http://localhost/private:01arz3ndektsv4rrffq69g5fav",
			undefined,
			env,
		);
		const html = await response.text();

		expect(response.status).toBe(403);
		expect(html).toContain("This page is private.");
		expect(html).toContain('id="login-link"');
		expect(html).not.toContain('data-action="source"');
	});

	test("renders authenticated UI without page actions for new page", async () => {
		const response = await app.request(
			"http://localhost/new?type=public",
			{ headers: authenticatedHeaders },
			env,
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain("Create a new public page");
		expect(html).toContain('<span class="printuser avatarhover">');
		expect(html).not.toContain('data-action="source"');
	});

	test("renders an empty auth nav for the signed-out login page", async () => {
		const response = await app.request("http://localhost/auth/login", undefined, env);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('<nav class="auth-nav" id="auth-user-nav"></nav>');
		expect(html).toContain('class="theme-toggle" id="theme-toggle"');
		expect(html).toContain('<span id="theme-toggle-icon" aria-hidden="true">◐</span>');
		expect(html).not.toContain('href="/user/settings"');
	});

	test("renders the previous passkey name and Conditional UI input", async () => {
		const cookie = await createLastLoginCookie(env, {
			method: "passkey",
			passkeyName: '<MacBook & "Touch ID">',
		});
		const response = await app.request(
			"http://localhost/auth/login",
			{ headers: { Cookie: cookie } },
			env,
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('id="passkey-autofill"');
		expect(html).toContain('autocomplete="webauthn"');
		expect(html).toContain('class="sr-only"');
		expect(html).toContain('tabindex="-1"');
		expect(html).toContain('aria-hidden="true"');
		expect(html).not.toContain("Choose a saved passkey");
		expect(html).not.toContain("Select from browser autofill");
		expect(html).toContain('<span class="last-used-badge">Last used</span>');
		expect(html).toContain("&lt;MacBook &amp; &quot;Touch ID&quot;&gt;");
		expect(html).not.toContain('<MacBook & "Touch ID">');
	});

	test("marks Wikidot as the previous login method", async () => {
		const cookie = await createLastLoginCookie(env, { method: "wikidot" });
		const response = await app.request(
			"http://localhost/auth/login",
			{ headers: { Cookie: cookie } },
			env,
		);
		const html = await response.text();

		expect(html).toContain(
			'<a href="/auth/oauth" class="btn btn-primary login-method"><span>Sign in with Wikidot</span><span class="last-used-badge">Last used</span></a>',
		);
		expect(html).not.toContain('class="last-passkey-name"');
	});

	test("renders the authenticated auth nav for a user page", async () => {
		const response = await app.request(
			"http://localhost/user/settings",
			{ headers: authenticatedHeaders },
			env,
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('<nav class="auth-nav" id="auth-user-nav">');
		expect(html).toContain('<span class="auth-nav-group">');
		expect(html).toContain('<span class="auth-account-group">');
		expect(html).toContain('<a href="/user/settings">Settings</a>');
		expect(html).toContain(
			'<a href="javascript:;" id="btn-logout" class="auth-signout">Sign out</a>',
		);
		expect(html).toContain('<span class="auth-user-name">Owner</span>');
		expect(html).toContain('class="relative-time"');
		expect(html).toContain('datetime="2026-01-01T00:00:00.000Z"');
		expect(html).toContain("data-relative-time");
		expect(html).toContain("data-relative-label=");
	});

	test("deletes the host-prefixed session cookie over HTTPS", async () => {
		const origin = "https://example.com";
		const response = await app.request(
			`${origin}/auth/logout`,
			{
				method: "POST",
				headers: {
					Origin: origin,
					"Content-Type": "application/json",
				},
			},
			env,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Set-Cookie")).toBe(
			"__Host-session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
		);
	});

	test("deletes the development session cookie over HTTP", async () => {
		const origin = "http://localhost";
		const response = await app.request(
			`${origin}/auth/logout`,
			{
				method: "POST",
				headers: {
					Origin: origin,
					"Content-Type": "application/json",
				},
			},
			env,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Set-Cookie")).toBe(
			"session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
		);
	});
});
