import type { CookieOptions } from "hono/utils/cookie";

/**
 * 環境に応じたcookie名を返す。
 * 本番: __Host- prefix (Secure必須、ドメイン固定)
 * 開発: prefix なし (HTTPでも動作)
 */
function isSecure(url: string): boolean {
	return url.startsWith("https://");
}

export function sessionCookieName(url: string): string {
	return isSecure(url) ? "__Host-session" : "session";
}

export function passkeyCookieName(url: string): string {
	return isSecure(url) ? "__Host-passkey_state" : "passkey_state";
}

export function oauthCookieName(url: string): string {
	return isSecure(url) ? "__Host-oauth_state" : "oauth_state";
}

export function sessionCookieOptions(url: string): CookieOptions {
	const secure = isSecure(url);
	return {
		httpOnly: true,
		secure,
		sameSite: "Lax",
		path: "/",
		maxAge: 30 * 24 * 60 * 60,
	};
}

export function stateCookieOptions(url: string, maxAge = 300): CookieOptions {
	const secure = isSecure(url);
	return {
		httpOnly: true,
		secure,
		sameSite: secure ? "Strict" : "Lax",
		path: "/",
		maxAge,
	};
}
