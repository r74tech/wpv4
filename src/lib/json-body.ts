import type { Context } from "hono";
import type { ZodType } from "zod";
import { utf8ByteLength } from "@/lib/bytes";
import type { AppEnv } from "@/types/env";

export const MAX_JSON_BYTES = 1_200_000;

export async function readJsonBody<T>(
	c: Context<AppEnv>,
	schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
	const contentType = c.req.header("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") {
		return {
			ok: false,
			response: c.json(
				{ error: "Content-Type must be application/json", code: "unsupported_media_type" },
				415,
			),
		};
	}
	const contentLength = Number(c.req.header("Content-Length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
		return {
			ok: false,
			response: c.json({ error: "Request body is too large", code: "payload_too_large" }, 413),
		};
	}
	const text = await c.req.text();
	if (utf8ByteLength(text) > MAX_JSON_BYTES) {
		return {
			ok: false,
			response: c.json({ error: "Request body is too large", code: "payload_too_large" }, 413),
		};
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return {
			ok: false,
			response: c.json({ error: "Invalid JSON", code: "validation" }, 400),
		};
	}
	const result = schema.safeParse(value);
	if (!result.success) {
		return {
			ok: false,
			response: c.json(
				{
					error: "Invalid request body",
					code: "validation",
					issues: result.error.issues.map((issue) => ({
						path: issue.path,
						message: issue.message,
					})),
				},
				400,
			),
		};
	}
	return { ok: true, data: result.data };
}
