/**
 * Files Worker - R2 から html-block / code-block を配信する。
 *
 * main Worker とは別オリジンで動かしてユーザー生成コンテンツを XSS 隔離する。
 *
 * URL パターン (Wikidot の wdfiles.com 互換):
 *   GET /local--html/<page>/<hash>    HTML block content (iframe sandbox)
 *   GET /local--code/<page>/<index>   Code block content (text/plain)
 *   GET /avatar?username=<name>       User avatar (dedicated R2 bucket)
 *   GET /common--javascript/html-block-iframe.js
 *                                     iframe リサイズスクリプト (@wdprlib/runtime 提供)
 *
 * 実装は @wdprlib examples/wdmock-cf/apps/files をベース。
 */

import { HTML_BLOCK_RESIZE_SCRIPT } from "@wdprlib/runtime";
import {
	AVATAR_CACHE_CONTROL,
	DEFAULT_AVATAR_KEY,
	MAX_AVATAR_BYTES,
	avatarKey,
	isAllowedAvatarContentType,
} from "../../src/services/avatar";

type Env = {
	DB: D1Database;
	FILES: R2Bucket;
	AVATARS: R2Bucket;
	ALLOWED_ORIGIN?: string;
	HTML_BLOCK_CSS_URL?: string;
	// private html-block の ukey 検証用 HMAC 鍵（main worker と共有）
	FILES_URL_SECRET?: string;
};

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const keyData = new TextEncoder().encode(secret);
	const key = await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return bytesToHex(new Uint8Array(sig));
}

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

const DEFAULT_HTML_BLOCK_CSS_URL = "https://wp.r74.tech/common--theme/base/css/html-block.css";
const DEFAULT_AVATAR_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH1gYDExsbqHUQgwAAAB10RVh0Q29tbWVudABDcmVhdGVkIHdpdGggVGhlIEdJTVDvZCVuAAACO0lEQVRYw+2Yv8/5QBzH26/vItTgRxj8iomoiM3AarWIGNiNYpP4B7qZGMxmZoMfAwkGiUkaVg0SA00rWr3v0OTSSJ4+zfF87xn6nu6d3l1f+fTuc/0cCQAgfpP+EL9MJpAJZAIZ1/P5DIVCJEmSJNlsNo0OAz8phmHUt1gslvl8bmTIzwJdLher1aoy0TQtSRJmIABAuVyGX6PVauEHmkwmEMjtdvM8jxlIURS/3w+ZGIbBDAQAqNfrECgQCMiyjAj0qf04Ho+18wwGA8xAj8fDbrfDeYrFImYgAEAmk4HzUBR1v9+/6vmfjg6apmH7drstFgvMZ1kikdDa2Wz2Vc+/+qfKp4Di8bjWbjYbzBFyuVxau9/vUSL0rUiSNBhgh8OhfcRxHOYIvQDxPI8ZiKIorZUkCTPQC4HNZsMMJIqizhr/2KI2nhdOp5PWBoNBzBE6HA5aG4vFUCL0sqvfyZMsy2ptKpXCHKHtdqu12rMWD9BqtYLtcDgciUTeBdJPyvqSZXm9XkObz+c/UCjqZI5vtVwuBUGAtlQqIQKpf0w+n48gCKfTiQw0Go20+yudTqNHiOO44/FIEEQymUQG6vf7sF2r1dBLaUVRKpWK2q3X66H9vO52O/gur9crCAJiGcSybDabVSfK5XL6tYuOGo0GBOp0OuiV6/l8VsvyQqFwvV7RaERR9Hg8Kk00Gn23tm+328Ph8J1io9vtwqwxnU4x334oihKNRlWgarVqcBRp3lObQCaQCYRZ/wA+c0YWT0b5PQAAAABJRU5ErkJggg==";

function defaultAvatarBytes(): Uint8Array {
	return Uint8Array.from(atob(DEFAULT_AVATAR_BASE64), (character) => character.charCodeAt(0));
}

async function avatarKeyForUsername(db: D1Database, username: string | null): Promise<string> {
	const normalized = username?.trim().toLowerCase() ?? "";
	if (!normalized || normalized.length > 128) return DEFAULT_AVATAR_KEY;
	const user = await db
		.prepare(
			"SELECT MIN(wikidot_id) AS wikidot_id, COUNT(*) AS matches FROM users WHERE avatar_unix_name = ?",
		)
		.bind(normalized)
		.first<{ wikidot_id: number | null; matches: number }>();
	return user?.matches === 1 &&
		typeof user.wikidot_id === "number" &&
		Number.isSafeInteger(user.wikidot_id) &&
		user.wikidot_id > 0
		? avatarKey(user.wikidot_id)
		: DEFAULT_AVATAR_KEY;
}

async function getAvatar(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
	const object = await bucket.get(key);
	const contentType = object?.httpMetadata?.contentType?.toLowerCase().split(";", 1)[0]?.trim();
	if (!object || object.size > MAX_AVATAR_BYTES || !isAllowedAvatarContentType(contentType)) {
		await object?.body.cancel();
		return null;
	}
	return object;
}

async function defaultAvatarResponse(
	bucket: R2Bucket,
	method: string,
	corsHeaders: Record<string, string>,
): Promise<Response> {
	const bytes = defaultAvatarBytes();
	try {
		await bucket.put(DEFAULT_AVATAR_KEY, bytes, {
			httpMetadata: {
				contentType: "image/png",
				cacheControl: AVATAR_CACHE_CONTROL,
			},
		});
	} catch (error) {
		console.error("Failed to cache the default avatar", error);
	}

	return new Response(method === "HEAD" ? null : bytes, {
		headers: {
			...corsHeaders,
			"Cache-Control": AVATAR_CACHE_CONTROL,
			"Content-Type": "image/png",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function htmlWrapperTemplate(cssUrl: string): string {
	return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html id="html-block-html" xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
<meta http-equiv="Content-type" content="text/html; charset=utf-8"/>
<link rel="stylesheet" href="${cssUrl}"/>
</head>
<body></body>
</html>`;
}

function addResizeScript(content: string, cssUrl: string): Response {
	const hasBody = /<body[\s>]/i.test(content);

	if (hasBody) {
		const response = new Response(content, {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
		return new HTMLRewriter()
			.on("body", {
				element(element) {
					element.append(
						'<script type="text/javascript" src="/common--javascript/html-block-iframe.js"></script>',
						{ html: true },
					);
				},
			})
			.transform(response);
	}

	const templateResponse = new Response(htmlWrapperTemplate(cssUrl), {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
	return new HTMLRewriter()
		.on("body", {
			element(element) {
				element.append(content, { html: true });
				element.append(
					'<script type="text/javascript" src="/common--javascript/html-block-iframe.js"></script>',
					{ html: true },
				);
			},
		})
		.transform(templateResponse);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const cssUrl = env.HTML_BLOCK_CSS_URL ?? DEFAULT_HTML_BLOCK_CSS_URL;

		const corsHeaders: Record<string, string> = {
			"Access-Control-Allow-Origin": env.ALLOWED_ORIGIN ?? "*",
			"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", { status: 405 });
		}

		if (path === "/common--javascript/html-block-iframe.js") {
			return new Response(HTML_BLOCK_RESIZE_SCRIPT, {
				headers: {
					...corsHeaders,
					"Content-Type": "text/javascript; charset=utf-8",
					"Cache-Control": "public, max-age=31536000, immutable",
				},
			});
		}

		if (path === "/avatar") {
			const key = await avatarKeyForUsername(env.DB, url.searchParams.get("username"));
			let object = await getAvatar(env.AVATARS, key);
			if (!object && key !== DEFAULT_AVATAR_KEY) {
				object = await getAvatar(env.AVATARS, DEFAULT_AVATAR_KEY);
			}
			if (!object) return defaultAvatarResponse(env.AVATARS, request.method, corsHeaders);

			const headers = new Headers({
				...corsHeaders,
				"Cache-Control": AVATAR_CACHE_CONTROL,
				"Content-Type": object.httpMetadata!.contentType!,
				ETag: object.httpEtag,
				"X-Content-Type-Options": "nosniff",
			});
			if (request.method === "HEAD") {
				await object.body.cancel();
				return new Response(null, { headers });
			}
			return new Response(object.body, { headers });
		}

		const htmlMatch = path.match(/^\/local--html\/([^/]+)\/([^/]+)$/);
		const privateHtmlMatch = path.match(/^\/private--html\/([^/]+)\/([^/]+)$/);
		const codeMatch = path.match(/^\/local--code\/([^/]+)\/([^/]+)$/);

		let key: string;
		let contentType: string;
		let cacheControl = "public, max-age=31536000, immutable";
		const securityHeaders: Record<string, string> = { "X-Content-Type-Options": "nosniff" };

		if (htmlMatch) {
			// public / share / その他 html-block: 誰でも CDN 経由で配信
			const [, page, hash] = htmlMatch;
			key = `local--html/${page}/${hash}`;
			contentType = "text/html; charset=utf-8";
		} else if (privateHtmlMatch) {
			// private html-block: ukey + exp の HMAC 検証必須、URL から ukey を削っても
			// public 経路に fallback しない（R2 prefix も別なので存在しない）
			const [, page, hash] = privateHtmlMatch;
			const secret = env.FILES_URL_SECRET;
			if (!secret) return new Response("Server misconfigured", { status: 500 });
			const ukey = url.searchParams.get("ukey") ?? "";
			const expStr = url.searchParams.get("exp") ?? "";
			const exp = Number(expStr);
			if (!ukey || !Number.isFinite(exp)) {
				return new Response("Forbidden", { status: 403 });
			}
			if (exp < Math.floor(Date.now() / 1000)) {
				return new Response("Forbidden: link expired", { status: 403 });
			}
			const expected = await hmacSha256Hex(secret, `${page}:${hash}:${exp}`);
			if (!timingSafeEqualHex(ukey, expected)) {
				return new Response("Forbidden", { status: 403 });
			}
			key = `private--html/${page}/${hash}`;
			contentType = "text/html; charset=utf-8";
			cacheControl = "private, no-store";
		} else if (codeMatch) {
			const [, page, index] = codeMatch;
			key = `local--code/${page}/${index}`;
			contentType = "text/plain; charset=utf-8";
		} else {
			return new Response("Not found", { status: 404 });
		}

		const object = await env.FILES.get(key);
		if (!object) {
			return new Response("Not found", { status: 404 });
		}

		const headers = new Headers({
			...corsHeaders,
			...securityHeaders,
			"Content-Type": object.httpMetadata?.contentType ?? contentType,
			ETag: object.httpEtag,
			"Cache-Control": cacheControl,
		});

		if (request.method === "HEAD") {
			return new Response(null, { headers });
		}

		// html-block は iframe sandbox 用にラップする（public/private とも同じラップ）
		if (htmlMatch || privateHtmlMatch) {
			const rawContent = await object.text();
			const transformed = addResizeScript(rawContent, cssUrl);
			const newHeaders = new Headers(transformed.headers);
			for (const [k, v] of headers.entries()) newHeaders.set(k, v);
			return new Response(transformed.body, { headers: newHeaders });
		}

		return new Response(object.body, { headers });
	},
};
