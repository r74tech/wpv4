import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, ne } from "drizzle-orm";
import { users, sessions } from "@/db/schema";
import { generatePkce, generateState, buildAuthorizeUrl, exchangeCode } from "@/services/oauth";
import { hashToken } from "@/middleware/session";
import { verifyCsrf } from "@/middleware/csrf";
import { storeChallenge, consumeChallenge } from "@/services/challenge-store";
import { avatarKey, storeWikidotAvatar } from "@/services/avatar";
import { readLastLoginMethod, rememberLastLoginMethod } from "@/lib/last-login-method";
import {
	sessionCookieName,
	sessionCookieOptions,
	oauthCookieName,
	stateCookieOptions,
} from "@/lib/cookie";
import { authRenderer } from "@/auth-renderer";
import { LoginPage } from "@/pages/auth/LoginPage";
import type { AppEnv } from "@/types/env";

const auth = new Hono<AppEnv>();

// --- ログインページ ---

auth.use("/login", authRenderer);
auth.get("/login", async (c) => {
	const user = c.get("user");
	if (user) return c.redirect("/", 302);
	return c.render(<LoginPage lastLoginMethod={await readLastLoginMethod(c)} />);
});

// --- OAuth フロー ---

auth.get("/oauth", async (c) => {
	const { codeVerifier, codeChallenge } = await generatePkce();
	const state = generateState();

	// サーバーサイドにOAuthステートを保存
	const stateKey = await storeChallenge(
		c.env.DB,
		{
			state,
			codeVerifier,
			type: "oauth",
		},
		600,
	);

	setCookie(c, oauthCookieName(c.req.url), stateKey, stateCookieOptions(c.req.url, 600));

	const redirectUri = new URL("/auth/callback", c.req.url).toString();
	const authorizeUrl = buildAuthorizeUrl(c.env, redirectUri, state, codeChallenge);
	return c.redirect(authorizeUrl, 302);
});

auth.get("/callback", async (c) => {
	const code = c.req.query("code");
	const returnedState = c.req.query("state");
	const stateKey = getCookie(c, oauthCookieName(c.req.url));

	if (!code || !returnedState || !stateKey) {
		return c.json({ error: "Missing parameters" }, 400);
	}

	// サーバーサイドから取得（使い捨て）
	const savedData = await consumeChallenge(c.env.DB, stateKey);
	if (!savedData || savedData.type !== "oauth") {
		return c.json({ error: "Invalid or expired state" }, 403);
	}

	const { state: savedState, codeVerifier } = savedData;
	if (returnedState !== savedState) {
		return c.json({ error: "State mismatch" }, 403);
	}

	const redirectUri = new URL("/auth/callback", c.req.url).toString();
	const tokenResponse = await exchangeCode(c.env, code, redirectUri, codeVerifier);
	const db = drizzle(c.env.DB);
	const avatarUnixName = tokenResponse.unix_name.trim().toLowerCase();
	const clearPreviousOwner = db
		.update(users)
		.set({ avatarUnixName: null })
		.where(and(eq(users.avatarUnixName, avatarUnixName), ne(users.wikidotId, tokenResponse.id)));
	const userValues = {
		wikidotId: tokenResponse.id,
		name: tokenResponse.name,
		unixName: tokenResponse.unix_name,
		avatarUnixName,
		lastLoginAt: new Date().toISOString(),
	};
	const [, upserted] = await db.batch([
		clearPreviousOwner,
		db
			.insert(users)
			.values(userValues)
			.onConflictDoUpdate({
				target: users.wikidotId,
				set: userValues,
			})
			.returning({ id: users.id }),
	]);
	const userId = upserted[0].id;

	try {
		if (!(await c.env.AVATARS.head(avatarKey(tokenResponse.id)))) {
			await storeWikidotAvatar(c.env.AVATARS, tokenResponse.id);
		}
	} catch (error) {
		console.error("Failed to store Wikidot avatar", error);
	}

	const sessionToken = crypto.randomUUID();
	const tokenHash = await hashToken(sessionToken);
	const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

	await db.insert(sessions).values({ tokenHash, userId, expiresAt });

	setCookie(c, sessionCookieName(c.req.url), sessionToken, sessionCookieOptions(c.req.url));
	await rememberLastLoginMethod(c, { method: "wikidot" });

	return c.redirect("/", 302);
});

auth.post("/logout", verifyCsrf, async (c) => {
	const token = getCookie(c, sessionCookieName(c.req.url));
	if (token) {
		const db = drizzle(c.env.DB);
		const tokenHash = await hashToken(token);
		await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
	}
	deleteCookie(c, sessionCookieName(c.req.url), sessionCookieOptions(c.req.url));
	return c.json({ ok: true });
});

export { auth };
