export const DEFAULT_AVATAR_KEY = "default/avatar";
export const MAX_AVATAR_BYTES = 1024 * 1024;
export const AVATAR_CACHE_CONTROL = "public, max-age=300";
export const AVATAR_FETCH_TIMEOUT_MS = 3000;

const allowedContentTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export type DownloadedAvatar = {
	bytes: Uint8Array;
	contentType: string;
};

export function avatarKey(wikidotId: number): string {
	if (!Number.isSafeInteger(wikidotId) || wikidotId <= 0) {
		throw new RangeError("Wikidot user ID must be a positive safe integer");
	}
	return `users/${wikidotId}/avatar`;
}

export function isAllowedAvatarContentType(value: string | undefined): value is string {
	return (
		value !== undefined && allowedContentTypes.has(value.toLowerCase().split(";", 1)[0]!.trim())
	);
}

export async function downloadWikidotAvatar(
	wikidotId: number,
	fetcher: typeof fetch = fetch,
	timeoutMs = AVATAR_FETCH_TIMEOUT_MS,
): Promise<DownloadedAvatar> {
	if (!Number.isSafeInteger(wikidotId) || wikidotId <= 0) {
		throw new RangeError("Wikidot user ID must be a positive safe integer");
	}
	const ids = wikidotId === 2 ? [2] : [wikidotId, 2];
	const signal = AbortSignal.timeout(timeoutMs);

	for (const id of ids) {
		const response = await fetcher(`https://www.wikidot.com/avatar.php?userid=${id}`, {
			redirect: "follow",
			signal,
		});
		if (response.status === 404 && id !== 2) {
			await response.body?.cancel();
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Wikidot avatar request failed with status ${response.status}`);
		}
		if (new URL(response.url).protocol !== "https:") {
			await response.body?.cancel();
			throw new Error("Wikidot avatar redirected outside HTTPS");
		}

		const contentType = response.headers
			.get("Content-Type")
			?.toLowerCase()
			.split(";", 1)[0]
			?.trim();
		if (!isAllowedAvatarContentType(contentType)) {
			await response.body?.cancel();
			throw new Error("Wikidot avatar returned an unsupported content type");
		}
		const contentLength = Number(response.headers.get("Content-Length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
			await response.body?.cancel();
			throw new Error("Wikidot avatar is too large");
		}

		return {
			bytes: await readLimitedResponseBody(response, MAX_AVATAR_BYTES, "Wikidot avatar"),
			contentType,
		};
	}

	throw new Error("Wikidot avatar was not found");
}

export async function storeWikidotAvatar(
	bucket: R2Bucket,
	wikidotId: number,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const avatar = await downloadWikidotAvatar(wikidotId, fetcher);
	await bucket.put(avatarKey(wikidotId), avatar.bytes, {
		httpMetadata: {
			contentType: avatar.contentType,
			cacheControl: AVATAR_CACHE_CONTROL,
		},
	});
}

export async function readLimitedResponseBody(
	response: Response,
	maxBytes: number,
	description: string,
): Promise<Uint8Array> {
	if (!response.body) throw new Error(`${description} returned an empty body`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`${description} is too large`);
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
