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
import { setCookie } from "hono/cookie";
import type { AppEnv } from "@/types/env";

const RP_NAME = "Wikitext Previewer v4";

function getRpId(url: string): string {
	return new URL(url).hostname;
}

function getOrigin(url: string): string {
	return new URL(url).origin;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
	const binary = String.fromCharCode(...bytes);
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

	// challengeをcookieに保存（短命）
	setCookie(c, "passkey_challenge", options.challenge, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 300,
	});

	return c.json(options);
});

const registerSchema = z.object({
	response: z.any(),
	name: z.string().default(""),
});

passkeyApi.post("/register/verify", requireAuth, zValidator("json", registerSchema), async (c) => {
	const user = c.get("user")!;
	const body = c.req.valid("json");
	const challenge = c.req.header("Cookie")?.match(/passkey_challenge=([^;]+)/)?.[1];

	if (!challenge) {
		return c.json({ error: "Challenge not found" }, 400);
	}

	const verification = await verifyRegistrationResponse({
		response: body.response as RegistrationResponseJSON,
		expectedChallenge: challenge,
		expectedOrigin: getOrigin(c.req.url),
		expectedRPID: getRpId(c.req.url),
	});

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
	const db = drizzle(c.env.DB);

	await db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)));
	return c.json({ ok: true });
});

// --- ログイン (未認証でもOK) ---

passkeyApi.get("/login/options", async (c) => {
	const options = await generateAuthenticationOptions({
		rpID: getRpId(c.req.url),
		userVerification: "preferred",
	});

	setCookie(c, "passkey_challenge", options.challenge, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 300,
	});

	return c.json(options);
});

const loginSchema = z.object({
	response: z.any(),
});

passkeyApi.post("/login/verify", zValidator("json", loginSchema), async (c) => {
	const body = c.req.valid("json");
	const challenge = c.req.header("Cookie")?.match(/passkey_challenge=([^;]+)/)?.[1];

	if (!challenge) {
		return c.json({ error: "Challenge not found" }, 400);
	}

	const authResponse = body.response as AuthenticationResponseJSON;
	const db = drizzle(c.env.DB);

	const pk = await db
		.select()
		.from(passkeys)
		.where(eq(passkeys.credentialId, authResponse.id))
		.limit(1);

	if (!pk[0]) {
		return c.json({ error: "Passkey not found" }, 401);
	}

	const verification = await verifyAuthenticationResponse({
		response: authResponse,
		expectedChallenge: challenge,
		expectedOrigin: getOrigin(c.req.url),
		expectedRPID: getRpId(c.req.url),
		credential: {
			id: pk[0].credentialId,
			publicKey: base64UrlToUint8Array(pk[0].publicKey),
			counter: pk[0].counter,
			transports: pk[0].transports ? JSON.parse(pk[0].transports) : undefined,
		},
	});

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

	// last_login_at更新
	await db
		.update(users)
		.set({ lastLoginAt: new Date().toISOString() })
		.where(eq(users.id, pk[0].userId));

	setCookie(c, "session_token", sessionToken, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 30 * 24 * 60 * 60,
	});

	return c.json({ ok: true });
});

export { passkeyApi };
