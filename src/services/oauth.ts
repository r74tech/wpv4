import type { Bindings } from "@/types/env";

type TokenResponse = {
	id: number;
	name: string;
	unix_name: string;
};

/**
 * PKCE用のcode_verifier/code_challengeペアを生成する。
 */
export async function generatePkce(): Promise<{
	codeVerifier: string;
	codeChallenge: string;
}> {
	const buffer = new Uint8Array(32);
	crypto.getRandomValues(buffer);
	const codeVerifier = base64UrlEncode(buffer);

	const encoded = new TextEncoder().encode(codeVerifier);
	const hash = await crypto.subtle.digest("SHA-256", encoded);
	const codeChallenge = base64UrlEncode(new Uint8Array(hash));

	return { codeVerifier, codeChallenge };
}

/**
 * ランダムなstate文字列を生成する。
 */
export function generateState(): string {
	const buffer = new Uint8Array(16);
	crypto.getRandomValues(buffer);
	return base64UrlEncode(buffer);
}

/**
 * Panopticonの認可URLを構築する。
 */
export function buildAuthorizeUrl(
	env: Bindings,
	redirectUri: string,
	state: string,
	codeChallenge: string,
): string {
	const params = new URLSearchParams({
		client_id: env.CLIENT_ID,
		redirect_uri: redirectUri,
		response_type: "code",
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});
	return `${env.OAUTH_PROVIDER_URL}/api/oauth/wikidot/authorize?${params}`;
}

/**
 * 認可コードをPanopticonのトークンエンドポイントで交換し、ユーザー情報を取得する。
 */
export async function exchangeCode(
	env: Bindings,
	code: string,
	redirectUri: string,
	codeVerifier: string,
): Promise<TokenResponse> {
	const origin = new URL(redirectUri).origin;
	const res = await fetch(`${env.OAUTH_PROVIDER_URL}/api/oauth/wikidot/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: origin,
		},
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: env.CLIENT_ID,
			client_secret: env.CLIENT_SECRET,
			code_verifier: codeVerifier,
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Token exchange failed: ${res.status} ${text}`);
	}

	return res.json() as Promise<TokenResponse>;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
