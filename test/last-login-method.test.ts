import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	readLastLoginMethod,
	rememberLastLoginMethod,
	type LastLoginMethod,
} from "../src/lib/last-login-method";
import type { AppEnv, Bindings } from "../src/types/env";

function createEnv(secret = "last-login-secret"): Bindings {
	return {
		DB: {} as D1Database,
		R2: {} as R2Bucket,
		AVATARS: {} as R2Bucket,
		OAUTH_PROVIDER_URL: "",
		CLIENT_ID: "",
		CLIENT_SECRET: "",
		SESSION_SECRET: secret,
		FILES_DOMAIN: "",
		FILES_URL_SECRET: "",
	};
}

function createApp(value: LastLoginMethod): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.get("/remember", async (c) => {
		return c.json({ stored: await rememberLastLoginMethod(c, value) });
	});
	app.get("/read", async (c) => c.json(await readLastLoginMethod(c)));
	return app;
}

async function readCookie(app: Hono<AppEnv>, cookie: string, env: Bindings): Promise<unknown> {
	const response = await app.request("http://localhost/read", { headers: { Cookie: cookie } }, env);
	return response.json();
}

describe("last login method cookie", () => {
	test("round trips a Unicode passkey name in a signed host cookie", async () => {
		const app = createApp({ method: "passkey", passkeyName: "MacBookのTouch ID" });
		const env = createEnv();
		const rememberResponse = await app.request("https://example.com/remember", undefined, env);
		const setCookie = rememberResponse.headers.get("Set-Cookie");

		expect(await rememberResponse.json()).toEqual({ stored: true });
		expect(setCookie).toContain("__Host-last_login_method=");
		expect(setCookie).toContain("Max-Age=2592000");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("SameSite=Lax");

		const cookie = setCookie?.split(";", 1)[0];
		const readResponse = await app.request(
			"https://example.com/read",
			{ headers: { Cookie: cookie ?? "" } },
			env,
		);

		expect(await readResponse.json()).toEqual({
			method: "passkey",
			passkeyName: "MacBookのTouch ID",
		});
	});

	test("rejects a tampered cookie or a cookie signed with another secret", async () => {
		const app = createApp({ method: "passkey", passkeyName: "MacBook Touch ID" });
		const env = createEnv();
		const response = await app.request("http://localhost/remember", undefined, env);
		const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";

		expect(await readCookie(app, `${cookie}x`, env)).toBeNull();
		expect(await readCookie(app, cookie, createEnv("rotated-secret"))).toBeNull();
	});

	test("skips the auxiliary cookie when SESSION_SECRET is empty", async () => {
		const app = createApp({ method: "wikidot" });
		const response = await app.request("http://localhost/remember", undefined, createEnv(""));

		expect(await response.json()).toEqual({ stored: false });
		expect(response.headers.get("Set-Cookie")).toBeNull();
	});
});
