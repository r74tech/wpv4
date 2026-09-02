import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_JSON_BYTES } from "@/lib/json-body";
import { auditApiMutations } from "@/middleware/api-audit";
import { requireApiKey } from "@/middleware/api-key-auth";
import type { AppEnv } from "@/types/env";
import { v1PageReadRoutes } from "./page-read";
import { v1PageWriteRoutes } from "./page-write";

const v1Api = new Hono<AppEnv>();

v1Api.onError((error, c) => {
	console.error("External API request failed", error);
	return c.json({ error: "Internal error", code: "internal" }, 500);
});

v1Api.use("*", requireApiKey);
v1Api.use("*", auditApiMutations);
v1Api.use(
	"*",
	bodyLimit({
		maxSize: MAX_JSON_BYTES,
		onError: (c) => c.json({ error: "Request body is too large", code: "payload_too_large" }, 413),
	}),
);

v1Api.get("/me", (c) => {
	const user = c.get("user")!;
	const key = c.get("apiKey")!;
	return c.json({
		user: {
			wikidot_id: user.wikidotId,
			name: user.name,
			unix_name: user.unixName,
		},
		key: {
			name: key.name,
			scopes: key.scopes,
			expires_at: key.expiresAt,
		},
	});
});

v1Api.route("/", v1PageReadRoutes);
v1Api.route("/", v1PageWriteRoutes);
v1Api.notFound((c) => c.json({ error: "Not found", code: "not_found" }, 404));

export { v1Api };
