import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { readLastLoginMethod } from "../src/lib/last-login-method";
import type { AppEnv, Bindings } from "../src/types/env";

let authenticationOutcome: "verified" | "unverified" | "exception" = "verified";

mock.module("@simplewebauthn/server", () => ({
	generateAuthenticationOptions: async () => ({
		challenge: "login-challenge",
		rpId: "localhost",
		userVerification: "preferred",
	}),
	verifyAuthenticationResponse: async () => {
		if (authenticationOutcome === "exception") throw new Error("invalid assertion");
		return {
			verified: authenticationOutcome === "verified",
			authenticationInfo: { newCounter: 9 },
		};
	},
	generateRegistrationOptions: async () => ({ challenge: "register-challenge" }),
	verifyRegistrationResponse: async () => ({ verified: false }),
}));

const { passkeyApi } = await import("../src/routes/passkey-api");

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
								meta: {
									changes: result.changes,
									last_row_id: Number(result.lastInsertRowid),
								},
							};
						},
					};
				},
			};
		},
	} as unknown as D1Database;
}

function createDatabase(): Database {
	const sqlite = new Database(":memory:");
	sqlite.run(`
		CREATE TABLE auth_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at TEXT NOT NULL);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			wikidot_id INTEGER NOT NULL UNIQUE,
			name TEXT NOT NULL,
			unix_name TEXT NOT NULL,
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
		CREATE TABLE passkeys (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
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
		DB: createD1(sqlite),
		R2: {} as R2Bucket,
		AVATARS: {} as R2Bucket,
		OAUTH_PROVIDER_URL: "",
		CLIENT_ID: "",
		CLIENT_SECRET: "",
		SESSION_SECRET: "passkey-test-secret",
		FILES_DOMAIN: "",
		FILES_URL_SECRET: "",
	};
}

function authenticationResponse() {
	return {
		id: "credential-1",
		rawId: "credential-1",
		response: {
			clientDataJSON: "client-data",
			authenticatorData: "authenticator-data",
			signature: "signature",
		},
		clientExtensionResults: {},
		type: "public-key",
	};
}

function insertPasskey(sqlite: Database): void {
	sqlite
		.query("INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (?, ?, ?, ?)")
		.run(7, 70, "Owner", "owner");
	sqlite
		.query(
			`INSERT INTO passkeys
				(id, user_id, credential_id, public_key, counter, transports, name)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(3, 7, "credential-1", "AQID", 4, "[]", "MacBook Touch ID");
}

async function requestOptions(app: Hono<AppEnv>, env: Bindings) {
	const response = await app.request("http://localhost/login/options", undefined, env);
	return (await response.json()) as {
		stateKey: string;
		options: { challenge: string; allowCredentials?: unknown[] };
	};
}

async function requestVerification(
	app: Hono<AppEnv>,
	env: Bindings,
	body: unknown,
): Promise<Response> {
	return app.request(
		"http://localhost/login/verify",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://localhost" },
			body: JSON.stringify(body),
		},
		env,
	);
}

function cookiePair(setCookie: string | null, name: string): string {
	return setCookie?.match(new RegExp(`(?:^|, )(${name}=[^;]+)`))?.[1] ?? "";
}

describe("Passkey login API", () => {
	const originalRandom = Math.random;

	beforeAll(() => {
		Math.random = () => 1;
	});

	beforeEach(() => {
		authenticationOutcome = "verified";
	});

	afterAll(() => {
		Math.random = originalRandom;
	});

	test("returns a per-request state key with authentication options", async () => {
		const sqlite = createDatabase();
		try {
			const app = new Hono<AppEnv>().route("/", passkeyApi);
			const response = await app.request(
				"http://localhost/login/options",
				undefined,
				createEnv(sqlite),
			);
			const body = (await response.json()) as {
				stateKey: string;
				options: { challenge: string; allowCredentials?: unknown[] };
			};

			expect(response.status).toBe(200);
			expect(body.stateKey).toBeString();
			expect(body.options.challenge).toBeString();
			expect(body.options.allowCredentials).toBeUndefined();
			expect(response.headers.get("Set-Cookie")).toBeNull();
			expect(sqlite.query("SELECT key FROM auth_state WHERE key = ?").get(body.stateKey)).toEqual({
				key: body.stateKey,
			});
		} finally {
			sqlite.close();
		}
	});

	test("creates a session and remembers the verified passkey name", async () => {
		const sqlite = createDatabase();
		try {
			insertPasskey(sqlite);
			const app = new Hono<AppEnv>().route("/", passkeyApi);
			const env = createEnv(sqlite);
			const { stateKey } = await requestOptions(app, env);
			const response = await requestVerification(app, env, {
				stateKey,
				response: authenticationResponse(),
			});

			expect(response.status).toBe(200);
			expect(sqlite.query("SELECT user_id FROM sessions").get()).toEqual({ user_id: 7 });
			expect(sqlite.query("SELECT counter FROM passkeys WHERE id = 3").get()).toEqual({
				counter: 9,
			});
			expect(sqlite.query("SELECT last_login_at FROM users WHERE id = 7").get()).toEqual({
				last_login_at: expect.any(String),
			});
			const setCookie = response.headers.get("Set-Cookie");
			expect(setCookie).toContain("session=");
			expect(setCookie).toContain("last_login_method=");
			const reader = new Hono<AppEnv>().get("/", async (c) => c.json(await readLastLoginMethod(c)));
			const remembered = await reader.request(
				"http://localhost/",
				{ headers: { Cookie: cookiePair(setCookie, "last_login_method") } },
				env,
			);
			expect(await remembered.json()).toEqual({
				method: "passkey",
				passkeyName: "MacBook Touch ID",
			});
		} finally {
			sqlite.close();
		}
	});

	test("rejects malformed authentication responses with the uniform error", async () => {
		const sqlite = createDatabase();
		try {
			const app = new Hono<AppEnv>().route("/", passkeyApi);
			const response = await requestVerification(app, createEnv(sqlite), {
				stateKey: crypto.randomUUID(),
				response: { id: "credential-1" },
			});

			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "Authentication failed" });
		} finally {
			sqlite.close();
		}
	});

	test("does not update authentication state when assertion verification fails", async () => {
		for (const outcome of ["unverified", "exception"] as const) {
			const sqlite = createDatabase();
			try {
				insertPasskey(sqlite);
				authenticationOutcome = outcome;
				const app = new Hono<AppEnv>().route("/", passkeyApi);
				const env = createEnv(sqlite);
				const { stateKey } = await requestOptions(app, env);
				const response = await requestVerification(app, env, {
					stateKey,
					response: authenticationResponse(),
				});

				expect(response.status).toBe(401);
				expect(sqlite.query("SELECT counter FROM passkeys WHERE id = 3").get()).toEqual({
					counter: 4,
				});
				expect(sqlite.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
				expect(response.headers.get("Set-Cookie")).toBeNull();
			} finally {
				sqlite.close();
			}
		}
	});

	test("consumes a successful state exactly once", async () => {
		const sqlite = createDatabase();
		try {
			insertPasskey(sqlite);
			const app = new Hono<AppEnv>().route("/", passkeyApi);
			const env = createEnv(sqlite);
			const { stateKey } = await requestOptions(app, env);
			const body = { stateKey, response: authenticationResponse() };

			expect((await requestVerification(app, env, body)).status).toBe(200);
			expect((await requestVerification(app, env, body)).status).toBe(401);
			expect(sqlite.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
		} finally {
			sqlite.close();
		}
	});
});
