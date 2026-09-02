import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { isUlidCategory, normalizeUlid } from "@/lib/visibility";
import { normalizePageTags } from "@/services/page-ops";
import { renderNav } from "@/services/nav";
import { renderWikitext } from "@/services/pipeline";
import type { AppEnv } from "@/types/env";
import { parseAndNormalize } from "@/routes/page-path";

const previewSchema = z.object({
	source: z.string(),
	page_path: z.string().optional(),
	page_name: z.string().default("preview"),
	category: z.string().default("_default"),
	tags: z.array(z.string()).default([]),
	url_path: z.string().optional(),
});

export const utilityRoutes = new Hono<AppEnv>()
	.post("/preview", zValidator("json", previewSchema), async (c) => {
		const body = c.req.valid("json");
		const viewerId = c.get("user")?.id ?? null;
		const [category, pageName] = body.page_path
			? parseAndNormalize(body.page_path)
			: [
					body.category,
					isUlidCategory(body.category) ? normalizeUlid(body.page_name) : body.page_name,
				];
		const urlPath =
			body.url_path ?? (body.page_path ? `/${body.page_path.replace(/^\/+/, "")}` : undefined);
		const result = await renderWikitext(body.source, c.env, {
			pageName,
			category,
			tags: normalizePageTags(body.tags),
			viewerId,
			urlPath,
			persistHtmlBlocks: false,
		});
		return c.json(result);
	})
	.get("/me", (c) => {
		const user = c.get("user");
		return user ? c.json({ authenticated: true, user }) : c.json({ authenticated: false });
	})
	.get("/sidebar", async (c) => {
		const result = await renderNav(c.env, "side", c.get("user")?.id ?? null);
		return c.json(result ?? { html: "", styles: [] });
	})
	.get("/topbar", async (c) => {
		const result = await renderNav(c.env, "top", c.get("user")?.id ?? null);
		return c.json(result ?? { html: "", styles: [] });
	});
