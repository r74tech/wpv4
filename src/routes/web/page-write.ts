import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "@/middleware/session";
import { changePageVisibility, createPage, deletePage, updatePage } from "@/services/page-ops";
import { renderWikitext } from "@/services/pipeline";
import { isValidUlid, normalizeUlid } from "@/lib/visibility";
import type { AppEnv } from "@/types/env";
import { parseAndNormalize, routeSuffix } from "@/routes/page-path";

const newPageSchema = z.object({
	type: z.enum(["public", "share", "private"]),
	title: z.string(),
	source: z.string(),
	tags: z.array(z.string()).default([]),
	comment: z.string().default(""),
});

const updatePageSchema = z.object({
	title: z.string(),
	source: z.string(),
	tags: z.array(z.string()).default([]),
	comment: z.string().default(""),
	base_revision_number: z.number(),
});

const visibilitySchema = z.object({
	target: z.enum(["public", "share", "private"]),
	expected_category: z.enum(["public", "share", "private"]),
	force: z.boolean().optional().default(false),
});

export const pageWriteRoutes = new Hono<AppEnv>()
	.post("/page/new", requireAuth, zValidator("json", newPageSchema), async (c) => {
		const body = c.req.valid("json");
		const user = c.get("user")!;
		const result = await createPage(drizzle(c.env.DB), {
			type: body.type,
			title: body.title,
			source: body.source,
			tags: body.tags,
			comment: body.comment,
			userId: user.id,
			now: new Date(),
		});
		const rendered = await renderWikitext(body.source, c.env, {
			pageName: result.unixName,
			category: body.type,
			tags: result.tags,
			viewerId: user.id,
			persistHtmlBlocks: true,
		});
		return c.json({ path: result.path, html: rendered.html, styles: rendered.styles });
	})
	.put("/page/*", requireAuth, zValidator("json", updatePageSchema), async (c) => {
		const pagePath = routeSuffix(c.req.path, "/page/");
		if (!pagePath) return c.json({ error: "Invalid path" }, 400);
		const [category, unixName] = parseAndNormalize(pagePath);
		const body = c.req.valid("json");
		const user = c.get("user")!;
		const result = await updatePage(drizzle(c.env.DB), {
			category,
			unixName,
			title: body.title,
			source: body.source,
			tags: body.tags,
			comment: body.comment,
			baseRevisionNumber: body.base_revision_number,
			userId: user.id,
			now: new Date(),
		});
		if (!result.ok) {
			if (result.reason === "not_found") return c.json({ error: "Page not found" }, 404);
			if (result.reason === "forbidden") return c.json({ error: "Forbidden" }, 403);
			if (result.reason === "locked") return c.json({ error: "Page is locked" }, 403);
			if (result.reason === "conflict") {
				return c.json({ error: "Conflict: page was modified concurrently" }, 409);
			}
			return c.json({ error: "Internal error" }, 500);
		}
		const rendered = await renderWikitext(body.source, c.env, {
			pageName: unixName,
			category,
			tags: result.tags,
			viewerId: user.id,
			persistHtmlBlocks: true,
		});
		return c.json({ html: rendered.html, styles: rendered.styles });
	})
	.post("/page/:ulid/visibility", requireAuth, zValidator("json", visibilitySchema), async (c) => {
		const ulid = normalizeUlid(c.req.param("ulid"));
		if (!isValidUlid(ulid)) return c.json({ error: "Invalid ULID" }, 400);
		const body = c.req.valid("json");
		const user = c.get("user")!;
		const result = await changePageVisibility(drizzle(c.env.DB), c.env.R2, {
			unixName: ulid,
			expectedCategory: body.expected_category,
			target: body.target,
			force: body.force,
			userId: user.id,
			now: new Date(),
		});
		if (result.ok) return c.json({ ok: true, new_path: result.path });
		if (result.reason === "not_found") return c.json({ error: "Page not found" }, 404);
		if (result.reason === "forbidden") return c.json({ error: "Forbidden" }, 403);
		if (result.reason === "locked") return c.json({ error: "Page is locked" }, 403);
		if (result.reason === "already_target") {
			return c.json({ error: "Already in target visibility" }, 400);
		}
		if (result.reason === "impact") {
			return c.json(
				{
					error: "Visibility change has notable impact",
					referenced_by: result.referencedBy.map((ref) => ({
						category: ref.category,
						unix_name: ref.unixName,
						title: ref.title,
					})),
					hidden_referenced_count: result.hiddenReferencedCount,
					include_becomes_broken: result.includeBecomesBroken,
					list_pages_presence_changes: result.listPagesPresenceChanges,
				},
				409,
			);
		}
		if (result.reason === "conflict") {
			return c.json(
				result.actualCategory
					? {
							error: "Page visibility was changed by another session. Reload and try again.",
							actual_category: result.actualCategory,
						}
					: { error: "Conflict: page was modified concurrently" },
				409,
			);
		}
		return c.json({ error: "Internal error" }, 500);
	})
	.delete("/page/*", requireAuth, async (c) => {
		const pagePath = routeSuffix(c.req.path, "/page/");
		if (!pagePath) return c.json({ error: "Invalid path" }, 400);
		const [category, unixName] = parseAndNormalize(pagePath);
		const result = await deletePage(drizzle(c.env.DB), {
			category,
			unixName,
			userId: c.get("user")!.id,
			now: new Date(),
		});
		if (result.ok) return c.json({ ok: true });
		if (result.reason === "not_found") return c.json({ error: "Page not found" }, 404);
		if (result.reason === "forbidden") return c.json({ error: "Forbidden" }, 403);
		if (result.reason === "locked") return c.json({ error: "Page is locked" }, 403);
		if (result.reason === "conflict") {
			return c.json({ error: "Conflict: page was modified concurrently" }, 409);
		}
		return c.json({ error: "Internal error" }, 500);
	});
