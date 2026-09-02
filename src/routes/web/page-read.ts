import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { pageTags, pages } from "@/db/schema";
import { canEditPage, canManagePage, canViewPage, getVisibility } from "@/lib/visibility";
import { parseIncludeSourcePath, resolveLocalIncludeUnixName } from "@/lib/include-reference";
import { renderWikitext } from "@/services/pipeline";
import type { AppEnv } from "@/types/env";
import { parseAndNormalize, routeSuffix } from "@/routes/page-path";

export const pageReadRoutes = new Hono<AppEnv>()
	.get("/page/*", async (c) => {
		const pagePath = routeSuffix(c.req.path, "/page/");
		if (!pagePath) return c.json({ error: "Invalid path" }, 400);
		const [category, unixName] = parseAndNormalize(pagePath);
		const viewerId = c.get("user")?.id ?? null;
		const db = drizzle(c.env.DB);
		const rows = await db
			.select()
			.from(pages)
			.where(
				and(eq(pages.category, category), eq(pages.unixName, unixName), isNull(pages.deletedAt)),
			)
			.limit(1);
		const page = rows[0];
		if (!page) return c.json({ error: "Page not found" }, 404);
		if (!canViewPage(page, viewerId)) return c.json({ error: "Forbidden" }, 403);

		const tags = await db
			.select({ tag: pageTags.tag })
			.from(pageTags)
			.where(eq(pageTags.pageId, page.id));
		const tagNames = tags.map(({ tag }) => tag);
		const result = await renderWikitext(page.source, c.env, {
			pageName: unixName,
			category,
			tags: tagNames,
			viewerId,
			urlPath: `/${pagePath}`,
			persistHtmlBlocks: true,
		});
		return c.json({
			category,
			unix_name: unixName,
			title: page.title,
			html: result.html,
			styles: result.styles,
			tags: tagNames,
			visibility: getVisibility(page.category, page.unixName),
			can_edit: canEditPage(page, viewerId),
			can_manage: canManagePage(page, viewerId),
		});
	})
	.get("/page-source/*", async (c) => {
		const pagePath = routeSuffix(c.req.path, "/page-source/");
		if (!pagePath) return c.json({ error: "Invalid path" }, 400);
		const [category, unixName] = parseAndNormalize(pagePath);
		const includeUnixName =
			c.req.query("include") === "1"
				? resolveLocalIncludeUnixName(parseIncludeSourcePath(pagePath))
				: null;
		const viewerId = c.get("user")?.id ?? null;
		const db = drizzle(c.env.DB);
		const selector = includeUnixName
			? and(eq(pages.unixName, includeUnixName), isNull(pages.deletedAt))
			: and(eq(pages.category, category), eq(pages.unixName, unixName), isNull(pages.deletedAt));
		const rows = await db.select().from(pages).where(selector).limit(1);
		const page = rows[0];
		if (!page) return c.json({ error: "Page not found" }, 404);
		if (!canViewPage(page, viewerId)) return c.json({ error: "Forbidden" }, 403);

		const tags = await db
			.select({ tag: pageTags.tag })
			.from(pageTags)
			.where(eq(pageTags.pageId, page.id));
		return c.json({
			title: page.title,
			source: page.source,
			tags: tags.map(({ tag }) => tag),
			revision_count: page.revisionCount,
		});
	});
