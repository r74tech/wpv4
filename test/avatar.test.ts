import { describe, expect, test } from "bun:test";
import filesWorker from "../files-worker/src/index";
import {
	MAX_AVATAR_BYTES,
	downloadWikidotAvatar,
	storeWikidotAvatar,
} from "../src/services/avatar";

function responseWithUrl(body: BodyInit, contentType: string, url: string, status = 200): Response {
	const response = new Response(body, { status, headers: { "Content-Type": contentType } });
	Object.defineProperty(response, "url", { value: url });
	return response;
}

function createObject(key: string, type = "image/png"): R2ObjectBody {
	const body = new Uint8Array([1, 2, 3]);
	return {
		key,
		size: body.byteLength,
		httpEtag: '"etag"',
		httpMetadata: { contentType: type },
		body: new Response(body).body!,
	} as R2ObjectBody;
}

describe("avatar storage", () => {
	test("stores a validated Wikidot image under the immutable ID key", async () => {
		const puts: Array<{ key: string; type: string | undefined }> = [];
		const bucket = {
			async put(key: string, _value: unknown, options: R2PutOptions) {
				puts.push({ key, type: options.httpMetadata?.contentType });
				return { key } as R2Object;
			},
		} as R2Bucket;

		await storeWikidotAvatar(bucket, 4053112, async () =>
			responseWithUrl(new Uint8Array([1, 2, 3]), "image/png", "https://cdn.example/avatar"),
		);

		expect(puts).toEqual([{ key: "users/4053112/avatar", type: "image/png" }]);
	});

	test("rejects an avatar body above the size limit", async () => {
		await expect(
			downloadWikidotAvatar(4053112, async () =>
				responseWithUrl(
					new Uint8Array(MAX_AVATAR_BYTES + 1),
					"image/png",
					"https://cdn.example/avatar",
				),
			),
		).rejects.toThrow("too large");
	});

	test("uses the Wikidot default image when a user avatar returns 404", async () => {
		const requested: string[] = [];
		const avatar = await downloadWikidotAvatar(999, async (input) => {
			requested.push(String(input));
			return requested.length === 1
				? responseWithUrl("", "text/plain", "https://www.wikidot.com/avatar.php", 404)
				: responseWithUrl(new Uint8Array([1]), "image/png", "https://cdn.example/default");
		});

		expect(requested).toEqual([
			"https://www.wikidot.com/avatar.php?userid=999",
			"https://www.wikidot.com/avatar.php?userid=2",
		]);
		expect(avatar.contentType).toBe("image/png");
	});

	test("bounds an unresponsive Wikidot avatar request", async () => {
		await expect(
			downloadWikidotAvatar(
				4053112,
				async (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal;
						if (!signal) return reject(new Error("Missing abort signal"));
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
				1,
			),
		).rejects.toThrow();
	});
});

describe("files worker avatar route", () => {
	test("resolves a Wikidot user ID directly to its immutable key", async () => {
		const gets: string[] = [];
		const response = await filesWorker.fetch(
			new Request("https://files.example.com/avatar?userId=4053112"),
			createFilesEnv({
				async get(key: string) {
					gets.push(key);
					return createObject(key);
				},
			} as R2Bucket),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(gets).toEqual(["users/4053112/avatar"]);
	});

	test("uses only the default key for every invalid or legacy identifier", async () => {
		for (const query of [
			"",
			"?userId=-1",
			"?userId=0",
			"?userId=-2",
			"?userId=1.5",
			"?userId=1e2",
			"?userId=%201",
			"?userId=9007199254740992",
			"?userId=..%2F..%2Fdefault",
			"?username=user",
		]) {
			const gets: string[] = [];
			const response = await filesWorker.fetch(
				new Request(`https://files.example.com/avatar${query}`),
				createFilesEnv({
					async get(key: string) {
						gets.push(key);
						return createObject(key);
					},
				} as R2Bucket),
			);

			expect(response.status).toBe(200);
			expect(gets).toEqual(["default/avatar"]);
		}
	});

	test("falls back to the default object when an ID object is missing", async () => {
		const gets: string[] = [];
		const response = await filesWorker.fetch(
			new Request("https://files.example.com/avatar?userId=4053112"),
			createFilesEnv({
				async get(key: string) {
					gets.push(key);
					return key === "default/avatar" ? createObject(key) : null;
				},
			} as R2Bucket),
		);

		expect(response.status).toBe(200);
		expect(gets).toEqual(["users/4053112/avatar", "default/avatar"]);
	});

	test("serves and caches the embedded default when the bucket is empty", async () => {
		const puts: string[] = [];
		const response = await filesWorker.fetch(
			new Request("https://files.example.com/avatar?userId=-1"),
			createFilesEnv({
				async get() {
					return null;
				},
				async put(key: string) {
					puts.push(key);
					return { key } as R2Object;
				},
			} as R2Bucket),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await response.arrayBuffer()).slice(0, 8)).toEqual(
			new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		);
		expect(puts).toEqual(["default/avatar"]);
	});
});

describe("files worker public HTML route", () => {
	function pageDb(category: string | null, failure = false): D1Database {
		return {
			prepare() {
				return {
					bind() {
						return {
							async first() {
								if (failure) throw new Error("simulated D1 failure");
								return category === null ? null : { category };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
	}

	function htmlObject(key: string): R2ObjectBody {
		return {
			key,
			size: 12,
			httpEtag: '"html-etag"',
			httpMetadata: { contentType: "text/html; charset=utf-8" },
			body: new Response("<p>block</p>").body!,
		} as R2ObjectBody;
	}

	test("serves only an active non-private page without cache reuse", async () => {
		const gets: string[] = [];
		const files = {
			async get(key: string) {
				gets.push(key);
				return htmlObject(key);
			},
		} as R2Bucket;
		const response = await filesWorker.fetch(
			new Request("https://files.example.com/local--html/page/hash", { method: "HEAD" }),
			createFilesEnv({} as R2Bucket, files, pageDb("share")),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(gets).toEqual(["local--html/page/hash"]);
	});

	test("fails closed before R2 for private, deleted, missing, or unavailable page state", async () => {
		for (const [db, status] of [
			[pageDb("private"), 404],
			[pageDb(null), 404],
			[pageDb(null, true), 503],
		] as const) {
			let gets = 0;
			const response = await filesWorker.fetch(
				new Request("https://files.example.com/local--html/page/hash", { method: "HEAD" }),
				createFilesEnv(
					{} as R2Bucket,
					{
						async get() {
							gets += 1;
							return null;
						},
					} as R2Bucket,
					db,
				),
			);
			expect(response.status).toBe(status);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(gets).toBe(0);
		}
	});
});

function createFilesEnv(
	avatars: R2Bucket,
	files: R2Bucket = {} as R2Bucket,
	db?: D1Database,
): { FILES: R2Bucket; AVATARS: R2Bucket; DB?: D1Database } {
	return {
		FILES: files,
		AVATARS: avatars,
		DB: db,
	};
}
