import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
	RegistrationResponseJSON,
	AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { passkeys, users, sessions } from "@/db/schema";
import { requireAuth, hashToken } from "@/middleware/session";
import { verifyCsrf } from "@/middleware/csrf";
import { storeChallenge, consumeChallenge, cleanupExpiredState } from "@/services/challenge-store";
import { getCookie, setCookie } from "hono/cookie";
import { passkeyCookieName, sessionCookieName, stateCookieOptions, sessionCookieOptions } from "@/lib/cookie";
import type { AppEnv } from "@/types/env";

const RP_NAME = "Wikitext Previewer v4";

function getRpId(url: string): string {
	return new URL(url).hostname;
}

function getOrigin(url: string): string {
	return new URL(url).origin;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToUint8Array(str: string): Uint8Array<ArrayBuffer> {
	const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

const passkeyApi = new Hono<AppEnv>();

// 変更系にCSRF保護を適用
passkeyApi.use("*", verifyCsrf);

// 低確率で期限切れstate掃除
passkeyApi.use("*", async (c, next) => {
	if (Math.random() < 0.01) {
		c.executionCtx.waitUntil(cleanupExpiredState(c.env.DB));
	}
	return next();
});

// --- 登録 (認証済みユーザー) ---

passkeyApi.get("/register/options", requireAuth, async (c) => {
	const user = c.get("user")!;
	const db = drizzle(c.env.DB);

	const existing = await db
		.select({ credentialId: passkeys.credentialId })
		.from(passkeys)
		.where(eq(passkeys.userId, user.id));

	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: getRpId(c.req.url),
		userID: new Uint8Array(new TextEncoder().encode(String(user.id)).buffer) as Uint8Array<ArrayBuffer>,
		userName: user.unixName,
		userDisplayName: user.name,
		excludeCredentials: existing.map((p) => ({
			id: p.credentialId,
		})),
		authenticatorSelection: {
			residentKey: "preferred",
			userVerification: "preferred",
		},
	});

	// challengeをサーバーサイドに保存し、キーのみをcookieで渡す
	const stateKey = await storeChallenge(c.env.DB, {
		challenge: options.challenge,
		type: "register",
		userId: String(user.id),
	});

	setCookie(c, passkeyCookieName(c.req.url), stateKey, stateCookieOptions(c.req.url));

	return c.json(options);
});

const registerSchema = z.object({
	response: z.unknown(),
	name: z.string().max(100).default(""),
});

passkeyApi.post("/register/verify", requireAuth, zValidator("json", registerSchema), async (c) => {
	const user = c.get("user")!;
	const body = c.req.valid("json");
	const stateKey = getCookie(c, passkeyCookieName(c.req.url));

	if (!stateKey) {
		return c.json({ error: "Challenge expired or missing" }, 400);
	}

	// サーバーサイドから取得（使い捨て）
	const state = await consumeChallenge(c.env.DB, stateKey);
	if (!state || state.type !== "register" || state.userId !== String(user.id)) {
		return c.json({ error: "Invalid or expired challenge" }, 400);
	}

	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response: body.response as unknown as RegistrationResponseJSON,
			expectedChallenge: state.challenge,
			expectedOrigin: getOrigin(c.req.url),
			expectedRPID: getRpId(c.req.url),
		});
	} catch {
		return c.json({ error: "Verification failed" }, 400);
	}

	if (!verification.verified || !verification.registrationInfo) {
		return c.json({ error: "Verification failed" }, 400);
	}

	const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

	const db = drizzle(c.env.DB);
	await db.insert(passkeys).values({
		userId: user.id,
		credentialId: credential.id,
		publicKey: uint8ArrayToBase64Url(credential.publicKey),
		counter: credential.counter,
		deviceType: credentialDeviceType,
		backedUp: credentialBackedUp ? 1 : 0,
		transports: JSON.stringify(credential.transports ?? []),
		name: body.name || `Passkey ${new Date().toISOString().slice(0, 10)}`,
	});

	return c.json({ ok: true });
});

// --- 削除 (認証済みユーザー) ---

passkeyApi.delete("/:id", requireAuth, async (c) => {
	const user = c.get("user")!;
	const id = Number(c.req.param("id"));
	if (!Number.isFinite(id) || id <= 0) {
		return c.json({ error: "Invalid ID" }, 400);
	}
	const db = drizzle(c.env.DB);

	await db
		.delete(passkeys)
		.where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)));

	return c.json({ ok: true });
});

// --- ログイン (未認証でもOK) ---

passkeyApi.get("/login/options", async (c) => {
	const options = await generateAuthenticationOptions({
		rpID: getRpId(c.req.url),
		userVerification: "preferred",
	});

	const stateKey = await storeChallenge(c.env.DB, {
		challenge: options.challenge,
		type: "login",
	});

	setCookie(c, passkeyCookieName(c.req.url), stateKey, stateCookieOptions(c.req.url));

	return c.json(options);
});

const loginSchema = z.object({
	response: z.unknown(),
});

passkeyApi.post("/login/verify", zValidator("json", loginSchema), async (c) => {
	const body = c.req.valid("json");
	const stateKey = getCookie(c, passkeyCookieName(c.req.url));

	if (!stateKey) {
		return c.json({ error: "Authentication failed" }, 401);
	}

	const state = await consumeChallenge(c.env.DB, stateKey);
	if (!state || state.type !== "login") {
		// 均一なエラーメッセージ（oracle防止）
		return c.json({ error: "Authentication failed" }, 401);
	}

	const authResponse = body.response as unknown as AuthenticationResponseJSON;
	const db = drizzle(c.env.DB);

	const pk = await db
		.select()
		.from(passkeys)
		.where(eq(passkeys.credentialId, authResponse.id))
		.limit(1);

	if (!pk[0]) {
		// 均一なエラーメッセージ・レスポンスタイミング
		return c.json({ error: "Authentication failed" }, 401);
	}

	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response: authResponse,
			expectedChallenge: state.challenge,
			expectedOrigin: getOrigin(c.req.url),
			expectedRPID: getRpId(c.req.url),
			credential: {
				id: pk[0].credentialId,
				publicKey: base64UrlToUint8Array(pk[0].publicKey),
				counter: pk[0].counter,
				transports: pk[0].transports ? JSON.parse(pk[0].transports) : undefined,
			},
		});
	} catch {
		return c.json({ error: "Authentication failed" }, 401);
	}

	if (!verification.verified) {
		return c.json({ error: "Authentication failed" }, 401);
	}

	// counterを更新
	await db
		.update(passkeys)
		.set({ counter: verification.authenticationInfo.newCounter })
		.where(eq(passkeys.id, pk[0].id));

	// セッション作成
	const sessionToken = crypto.randomUUID();
	const tokenHash = await hashToken(sessionToken);
	const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

	await db.insert(sessions).values({
		tokenHash,
		userId: pk[0].userId,
		expiresAt,
	});

	await db
		.update(users)
		.set({ lastLoginAt: new Date().toISOString() })
		.where(eq(users.id, pk[0].userId));

	setCookie(c, sessionCookieName(c.req.url), sessionToken, sessionCookieOptions(c.req.url));

	return c.json({ ok: true });
});

export { passkeyApi };
