import type { Context } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { lastLoginMethodCookieName, sessionCookieOptions } from "@/lib/cookie";
import type { AppEnv } from "@/types/env";

const COOKIE_PURPOSE = "wpv4:last-login-method";
const COOKIE_VERSION = 1;
const MAX_PASSKEY_NAME_LENGTH = 100;

export type LastLoginMethod = { method: "wikidot" } | { method: "passkey"; passkeyName: string };

type LastLoginMethodPayload = LastLoginMethod & {
	purpose: typeof COOKIE_PURPOSE;
	version: typeof COOKIE_VERSION;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePayload(raw: string): LastLoginMethod | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!isRecord(value) || value.purpose !== COOKIE_PURPOSE || value.version !== COOKIE_VERSION) {
		return null;
	}
	if (value.method === "wikidot") {
		return { method: "wikidot" };
	}
	if (
		value.method === "passkey" &&
		typeof value.passkeyName === "string" &&
		value.passkeyName.length > 0 &&
		value.passkeyName.length <= MAX_PASSKEY_NAME_LENGTH
	) {
		return { method: "passkey", passkeyName: value.passkeyName };
	}
	return null;
}

function toPayload(value: LastLoginMethod): LastLoginMethodPayload | null {
	if (
		value.method === "passkey" &&
		(value.passkeyName.length === 0 || value.passkeyName.length > MAX_PASSKEY_NAME_LENGTH)
	) {
		return null;
	}
	return { purpose: COOKIE_PURPOSE, version: COOKIE_VERSION, ...value };
}

export async function readLastLoginMethod(c: Context<AppEnv>): Promise<LastLoginMethod | null> {
	if (!c.env.SESSION_SECRET) return null;
	try {
		const raw = await getSignedCookie(
			c,
			c.env.SESSION_SECRET,
			lastLoginMethodCookieName(c.req.url),
		);
		return typeof raw === "string" ? parsePayload(raw) : null;
	} catch {
		return null;
	}
}

export async function rememberLastLoginMethod(
	c: Context<AppEnv>,
	value: LastLoginMethod,
): Promise<boolean> {
	const payload = toPayload(value);
	if (!c.env.SESSION_SECRET || !payload) return false;
	try {
		await setSignedCookie(
			c,
			lastLoginMethodCookieName(c.req.url),
			JSON.stringify(payload),
			c.env.SESSION_SECRET,
			sessionCookieOptions(c.req.url),
		);
		return true;
	} catch (error) {
		console.error("Failed to store last login method", error);
		return false;
	}
}
