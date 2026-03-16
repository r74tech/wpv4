import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import { users, sessions, revisions, pages } from "@/db/schema";
import { generatePkce, generateState, buildAuthorizeUrl, exchangeCode } from "@/services/oauth";
import { hashToken, requireAuth } from "@/middleware/session";
import { renderer } from "@/renderer";
import { SettingsPage } from "@/pages/auth/SettingsPage";
import { ActivitiesPage } from "@/pages/auth/ActivitiesPage";
import type { AppEnv } from "@/types/env";

const auth = new Hono<AppEnv>();

// --- OAuth フロー ---

auth.get("/login", async (c) => {
	const { codeVerifier, codeChallenge } = await generatePkce();
	const state = generateState();

	setCookie(c, "oauth_code_verifier", codeVerifier, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 600,
	});
	setCookie(c, "oauth_state", state, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 600,
	});

	const redirectUri = new URL("/auth/callback", c.req.url).toString();
	const authorizeUrl = buildAuthorizeUrl(c.env, redirectUri, state, codeChallenge);
	return c.redirect(authorizeUrl, 302);
});

auth.get("/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const savedState = getCookie(c, "oauth_state");
	const codeVerifier = getCookie(c, "oauth_code_verifier");

	deleteCookie(c, "oauth_state", { path: "/" });
	deleteCookie(c, "oauth_code_verifier", { path: "/" });

	if (!code || !state || !savedState || !codeVerifier) {
		return c.json({ error: "Missing parameters" }, 400);
	}

	if (state !== savedState) {
		return c.json({ error: "State mismatch" }, 403);
	}

	const redirectUri = new URL("/auth/callback", c.req.url).toString();
	const tokenResponse = await exchangeCode(c.env, code, redirectUri, codeVerifier);
	const db = drizzle(c.env.DB);

	const existing = await db
		.select()
		.from(users)
		.where(eq(users.wikidotId, tokenResponse.id))
		.limit(1);

	let userId: number;
	if (existing[0]) {
		userId = existing[0].id;
		await db
			.update(users)
			.set({
				name: tokenResponse.name,
				unixName: tokenResponse.unix_name,
				lastLoginAt: new Date().toISOString(),
			})
			.where(eq(users.id, userId));
	} else {
		const result = await db
			.insert(users)
			.values({
				wikidotId: tokenResponse.id,
				name: tokenResponse.name,
				unixName: tokenResponse.unix_name,
				lastLoginAt: new Date().toISOString(),
			})
			.returning({ id: users.id });
		userId = result[0].id;
	}

	const sessionToken = crypto.randomUUID();
	const tokenHash = await hashToken(sessionToken);
	const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

	await db.insert(sessions).values({ tokenHash, userId, expiresAt });

	setCookie(c, "session_token", sessionToken, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 30 * 24 * 60 * 60,
	});

	return c.redirect("/", 302);
});

auth.post("/logout", async (c) => {
	const token = getCookie(c, "session_token");
	if (token) {
		const db = drizzle(c.env.DB);
		const tokenHash = await hashToken(token);
		await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
	}
	deleteCookie(c, "session_token", { path: "/" });
	return c.json({ ok: true });
});

// --- 認証済みユーザー専用ページ（renderer経由でWikidot shell内に描画） ---

auth.use("/settings", requireAuth, renderer);
auth.use("/activities", requireAuth, renderer);

auth.get("/settings", async (c) => {
	const user = c.get("user")!;
	const db = drizzle(c.env.DB);

	const userRow = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
	const u = userRow[0];
	if (!u) return c.notFound();

	return c.render(
		<SettingsPage
			user={{
				name: u.name,
				unixName: u.unixName,
				wikidotId: u.wikidotId,
				createdAt: u.createdAt,
				lastLoginAt: u.lastLoginAt,
			}}
		/>,
	);
});

auth.get("/activities", async (c) => {
	const user = c.get("user")!;
	const db = drizzle(c.env.DB);

	const recentRevisions = await db
		.select({
			revisionNumber: revisions.revisionNumber,
			title: revisions.title,
			comment: revisions.comment,
			createdAt: revisions.createdAt,
			category: pages.category,
			unixName: pages.unixName,
		})
		.from(revisions)
		.innerJoin(pages, eq(revisions.pageId, pages.id))
		.where(eq(revisions.createdBy, user.id))
		.orderBy(desc(revisions.createdAt))
		.limit(50);

	return c.render(
		<ActivitiesPage
			revisions={recentRevisions.map((r) => ({
				pagePath: `${r.category}:${r.unixName}`,
				revisionNumber: r.revisionNumber,
				title: r.title,
				comment: r.comment,
				createdAt: r.createdAt,
			}))}
		/>,
	);
});

export { auth };
