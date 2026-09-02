import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { utf8ByteLength } from "@/lib/bytes";
import { readJsonBody } from "@/lib/json-body";
import { isValidUlid } from "@/lib/visibility";
import { requireApiScope } from "@/middleware/api-key-auth";
import { parseAndNormalize, routeSuffix, strictPagePath } from "@/routes/page-path";
import {
	changePageVisibility,
	createPage,
	deletePage,
	normalizePageTags,
	updatePage,
	type PageOperationError,
} from "@/services/page-ops";
import { renderWikitext } from "@/services/pipeline";
import type { AppEnv } from "@/types/env";

const titleSchema = z.string().max(128);
const sourceSchema = z.string().superRefine((value, context) => {
	if (utf8ByteLength(value) > 1_000_000) {
		context.addIssue({ code: "custom", message: "Source must be at most 1,000,000 bytes" });
	}
});
const tagsSchema = z
	.array(z.string().max(128))
	.max(50)
	.default([])
	.transform(normalizePageTags)
	.refine((tags) => tags.length <= 50, { message: "At most 50 normalized tags are allowed" });
const createSchema = z.object({
	type: z.enum(["public", "share", "private"]),
	title: titleSchema,
	source: sourceSchema,
	tags: tagsSchema,
	comment: z.string().max(500).default(""),
});
const updateSchema = z.object({
	title: titleSchema,
	source: sourceSchema,
	tags: tagsSchema,
	comment: z.string().max(500).default(""),
	base_revision_number: z.number().int().nonnegative(),
});
const visibilitySchema = z.object({
	target: z.enum(["public", "share", "private"]),
	force: z.boolean().default(false),
});

async function renderSavedPage(
	source: string,
	env: AppEnv["Bindings"],
	options: Parameters<typeof renderWikitext>[2],
) {
	try {
		const rendered = await renderWikitext(source, env, options);
		return { html: rendered.html, styles: rendered.styles };
	} catch (error) {
		console.error("Saved page rendering failed", error);
		return {
			html: null,
			styles: [] as string[],
			render_error: {
				code: "render_failed",
				message: "The page was saved, but rendering failed",
			},
		};
	}
}

function operationError(error: PageOperationError) {
	switch (error.reason) {
		case "not_found":
			return { status: 404 as const, body: { error: "Page not found", code: "not_found" } };
		case "forbidden":
			return { status: 403 as const, body: { error: "Forbidden", code: "forbidden" } };
		case "locked":
			return { status: 403 as const, body: { error: "Page is locked", code: "locked" } };
		case "already_target":
			return {
				status: 400 as const,
				body: { error: "Already in target visibility", code: "validation" },
			};
		case "conflict":
			return {
				status: 409 as const,
				body: {
					error: "Page was modified concurrently",
					code: "conflict",
					...(error.currentRevisionNumber === undefined
						? {}
						: { current_revision_number: error.currentRevisionNumber }),
					...(error.actualCategory === undefined ? {} : { actual_category: error.actualCategory }),
				},
			};
		case "impact":
			return {
				status: 409 as const,
				body: {
					error: "Visibility change has notable impact",
					code: "conflict",
					referenced_by: error.referencedBy.map((page) => ({
						category: page.category,
						unix_name: page.unixName,
						title: page.title,
					})),
					hidden_referenced_count: error.hiddenReferencedCount,
					include_becomes_broken: error.includeBecomesBroken,
					list_pages_presence_changes: error.listPagesPresenceChanges,
				},
			};
		case "internal":
			return { status: 500 as const, body: { error: "Internal error", code: "internal" } };
	}
}

export const v1PageWriteRoutes = new Hono<AppEnv>()
	.post("/pages", requireApiScope("pages:write"), async (c) => {
		const body = await readJsonBody(c, createSchema);
		if (!body.ok) return body.response;
		const user = c.get("user")!;
		const result = await createPage(drizzle(c.env.DB), {
			type: body.data.type,
			title: body.data.title,
			source: body.data.source,
			tags: body.data.tags,
			comment: body.data.comment,
			userId: user.id,
			now: new Date(),
		});
		const rendered = await renderSavedPage(body.data.source, c.env, {
			pageName: result.unixName,
			category: body.data.type,
			tags: result.tags,
			viewerId: user.id,
			urlPath: `/${result.path}`,
			persistHtmlBlocks: true,
		});
		return c.json(
			{
				path: result.path,
				category: body.data.type,
				unix_name: result.unixName,
				revision_number: 0,
				url: new URL(`/${result.path}`, c.req.url).toString(),
				html: rendered.html,
				styles: rendered.styles,
				...("render_error" in rendered ? { render_error: rendered.render_error } : {}),
			},
			201,
		);
	})
	.put("/pages/*", requireApiScope("pages:write"), async (c) => {
		const pagePath = strictPagePath(routeSuffix(c.req.path, "/pages/"));
		if (!pagePath) return c.json({ error: "Not found", code: "not_found" }, 404);
		const body = await readJsonBody(c, updateSchema);
		if (!body.ok) return body.response;
		const [category, unixName] = parseAndNormalize(pagePath);
		const result = await updatePage(drizzle(c.env.DB), {
			category,
			unixName,
			title: body.data.title,
			source: body.data.source,
			tags: body.data.tags,
			comment: body.data.comment,
			baseRevisionNumber: body.data.base_revision_number,
			userId: c.get("user")!.id,
			now: new Date(),
		});
		if (!result.ok) {
			const error = operationError(result);
			return c.json(error.body, error.status);
		}
		const rendered = await renderSavedPage(body.data.source, c.env, {
			pageName: unixName,
			category,
			tags: result.tags,
			viewerId: c.get("user")!.id,
			urlPath: `/${category}:${unixName}`,
			persistHtmlBlocks: true,
		});
		return c.json({
			path: `${category}:${unixName}`,
			revision_number: result.revisionNumber,
			html: rendered.html,
			styles: rendered.styles,
			...("render_error" in rendered ? { render_error: rendered.render_error } : {}),
		});
	})
	.delete("/pages/*", requireApiScope("pages:delete"), async (c) => {
		const pagePath = strictPagePath(routeSuffix(c.req.path, "/pages/"));
		if (!pagePath) return c.json({ error: "Not found", code: "not_found" }, 404);
		const [category, unixName] = parseAndNormalize(pagePath);
		const result = await deletePage(drizzle(c.env.DB), {
			category,
			unixName,
			userId: c.get("user")!.id,
			now: new Date(),
		});
		if (!result.ok) {
			const error = operationError(result);
			return c.json(error.body, error.status);
		}
		return c.json({
			path: `${category}:${unixName}`,
			deleted_at: result.deletedAt,
		});
	})
	.post("/pages/*", requireApiScope("pages:visibility"), async (c) => {
		const suffix = routeSuffix(c.req.path, "/pages/");
		if (!suffix?.endsWith("/visibility")) {
			return c.json({ error: "Not found", code: "not_found" }, 404);
		}
		const pagePath = strictPagePath(suffix.slice(0, -"/visibility".length));
		if (!pagePath) return c.json({ error: "Not found", code: "not_found" }, 404);
		const [category, unixName] = parseAndNormalize(pagePath);
		if (
			(category !== "public" && category !== "share" && category !== "private") ||
			!isValidUlid(unixName)
		) {
			return c.json(
				{ error: "Visibility requires a public/share/private ULID page", code: "validation" },
				400,
			);
		}
		const body = await readJsonBody(c, visibilitySchema);
		if (!body.ok) return body.response;
		const result = await changePageVisibility(drizzle(c.env.DB), c.env.R2, {
			unixName,
			expectedCategory: category,
			target: body.data.target,
			force: body.data.force,
			userId: c.get("user")!.id,
			now: new Date(),
		});
		if (!result.ok) {
			const error = operationError(result);
			return c.json(error.body, error.status);
		}
		return c.json({
			path: result.path,
			revision_number: result.revisionNumber,
		});
	});
