import { Hono } from "hono";
import { verifyCsrf } from "@/middleware/csrf";
import { apiKeys } from "@/routes/api-keys";
import { passkeyApi } from "@/routes/passkey-api";
import type { AppEnv } from "@/types/env";
import { historyRoutes } from "./history";
import { pageReadRoutes } from "./page-read";
import { pageWriteRoutes } from "./page-write";
import { utilityRoutes } from "./utilities";

export const webApi = new Hono<AppEnv>()
	.use("*", verifyCsrf)
	.route("/", pageReadRoutes)
	.route("/", pageWriteRoutes)
	.route("/", historyRoutes)
	.route("/", utilityRoutes)
	.route("/api-keys", apiKeys)
	.route("/passkeys", passkeyApi);
