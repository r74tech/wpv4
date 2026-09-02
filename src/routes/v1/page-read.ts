import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { pageTags, pages } from "@/db/schema";
import { canViewPage, getVisibility } from "@/lib/visibility";
import { requireApiScope } from "@/middleware/api-key-auth";
import { parseAndNormalize, routeSuffix, strictPagePath } from "@/routes/page-path";
import { renderWikitext } from "@/services/pipeline";
import type { AppEnv } from "@/types/env";

async function findPage(db: ReturnType<typeof drizzle>, pagePath: string) {
	const [category, unixName] = parseAndNormalize(pagePath);
	const rows = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName), isNull(pages.deletedAt)))
		.limit(1);
	return rows[0] ?? null;
}

async function loadTags(db: ReturnType<typeof drizzle>, pageId: number): Promise<string[]> {
	const rows = await db
		.select({ tag: pageTags.tag })
		.from(pageTags)
		.where(eq(pageTags.pageId, pageId));
	return rows.map(({ tag }) => tag);
}

export const v1PageReadRoutes = new Hono<AppEnv>()
	.get("/pages", requireApiScope("pages:read"), async (c) => {
		const user = c.get("user")!;
		const rows = await drizzle(c.env.DB)
			.select({
				category: pages.category,
				unixName: pages.unixName,
				title: pages.title,
				revisionCount: pages.revisionCount,
				createdAt: pages.createdAt,
				updatedAt: pages.updatedAt,
			})
			.from(pages)
			.where(and(eq(pages.createdBy, user.id), isNull(pages.deletedAt)))
			.orderBy(desc(pages.updatedAt), desc(pages.id));
		return c.json({
			pages: rows.map((page) => ({
				path: `${page.category}:${page.unixName}`,
				title: page.title,
				visibility: getVisibility(page.category, page.unixName),
				revision_number: page.revisionCount ?? 0,
				created_at: page.createdAt,
				updated_at: page.updatedAt,
			})),
		});
	})
	.get("/pages/*/render", requireApiScope("pages:render"), async (c) => {
		const suffix = routeSuffix(c.req.path, "/pages/");
		const pagePath = strictPagePath(
			suffix?.endsWith("/render") ? suffix.slice(0, -"/render".length) : null,
		);
		if (!pagePath) return c.json({ error: "Not found", code: "not_found" }, 404);
		const db = drizzle(c.env.DB);
		const page = await findPage(db, pagePath);
		if (!page) return c.json({ error: "Page not found", code: "not_found" }, 404);
		const viewerId = c.get("user")!.id;
		if (!canViewPage(page, viewerId)) {
			return c.json({ error: "Forbidden", code: "forbidden" }, 403);
		}
		const tags = await loadTags(db, page.id);
		const result = await renderWikitext(page.source, c.env, {
			pageName: page.unixName,
			category: page.category,
			tags,
			viewerId,
			urlPath: `/${pagePath}`,
			persistHtmlBlocks: true,
		});
		return c.json({
			path: `${page.category}:${page.unixName}`,
			title: page.title,
			html: result.html,
			styles: result.styles,
		});
	})
	.get("/pages/*", requireApiScope("pages:read"), async (c) => {
		const pagePath = strictPagePath(routeSuffix(c.req.path, "/pages/"));
		if (!pagePath) return c.json({ error: "Not found", code: "not_found" }, 404);
		const db = drizzle(c.env.DB);
		const page = await findPage(db, pagePath);
		if (!page) return c.json({ error: "Page not found", code: "not_found" }, 404);
		if (!canViewPage(page, c.get("user")!.id)) {
			return c.json({ error: "Forbidden", code: "forbidden" }, 403);
		}
		return c.json({
			path: `${page.category}:${page.unixName}`,
			title: page.title,
			source: page.source,
			tags: await loadTags(db, page.id),
			visibility: getVisibility(page.category, page.unixName),
			revision_number: page.revisionCount ?? 0,
			created_at: page.createdAt,
			updated_at: page.updatedAt,
		});
	});
