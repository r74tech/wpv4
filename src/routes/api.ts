import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { pages, revisions, pageTags } from "@/db/schema";
import { renderWikitext, parsePagePath } from "@/services/pipeline";
import { requireAuth } from "@/middleware/session";
import { verifyCsrf } from "@/middleware/csrf";
import type { AppEnv } from "@/types/env";

const api = new Hono<AppEnv>();

// 変更系APIにCSRF + 認証ミドルウェアを適用
api.use("*", verifyCsrf);

// ページ取得（レンダリング済みHTML）
api.get("/page/*", async (c) => {
	const pagePath = c.req.path.replace("/api/page/", "");
	const [category, unixName] = parsePagePath(pagePath);
	const db = drizzle(c.env.DB);

	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}

	const tags = await db
		.select({ tag: pageTags.tag })
		.from(pageTags)
		.where(eq(pageTags.pageId, page[0].id));

	const result = await renderWikitext(page[0].source, c.env, {
		pageName: unixName,
		category,
		tags: tags.map((t) => t.tag),
	});

	return c.json({
		page_id: page[0].id,
		category,
		unix_name: unixName,
		title: page[0].title,
		html: result.html,
		styles: result.styles,
		revision_count: page[0].revisionCount,
		updated_at: page[0].updatedAt,
	});
});

// ソース取得（編集用）
api.get("/page-source/*", async (c) => {
	const pagePath = c.req.path.replace("/api/page-source/", "");
	const [category, unixName] = parsePagePath(pagePath);
	const db = drizzle(c.env.DB);

	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}

	const tags = await db
		.select({ tag: pageTags.tag })
		.from(pageTags)
		.where(eq(pageTags.pageId, page[0].id));

	return c.json({
		title: page[0].title,
		source: page[0].source,
		tags: tags.map((t) => t.tag),
		revision_count: page[0].revisionCount,
	});
});

// ページ保存（作成・更新）
const savePageSchema = z.object({
	title: z.string(),
	source: z.string(),
	tags: z.array(z.string()).default([]),
	comment: z.string().default(""),
	base_revision_number: z.number().nullable().optional(),
});

api.put("/page/*", requireAuth, zValidator("json", savePageSchema), async (c) => {
	const pagePath = c.req.path.replace("/api/page/", "");
	const [category, unixName] = parsePagePath(pagePath);
	const body = c.req.valid("json");
	const user = c.get("user")!;
	const db = drizzle(c.env.DB);

	const existing = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (existing[0]) {
		// 更新
		const page = existing[0];
		if (page.isLocked) {
			return c.json({ error: "Page is locked" }, 403);
		}
		if (body.base_revision_number == null) {
			return c.json({ error: "base_revision_number is required for updates" }, 400);
		}
		if (page.revisionCount !== body.base_revision_number) {
			return c.json({ error: "Conflict: page has been modified" }, 409);
		}

		const newRevisionNumber = (page.revisionCount ?? 0) + 1;
		await db.batch([
			db.insert(revisions).values({
				pageId: page.id,
				revisionNumber: newRevisionNumber,
				title: body.title,
				source: body.source,
				comment: body.comment,
				createdBy: user.id,
			}),
			db
				.update(pages)
				.set({
					title: body.title,
					source: body.source,
					revisionCount: newRevisionNumber,
					updatedBy: user.id,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(pages.id, page.id)),
			// タグ: 全削除→再挿入
			db.delete(pageTags).where(eq(pageTags.pageId, page.id)),
			...body.tags.map((tag) =>
				db.insert(pageTags).values({ pageId: page.id, tag }),
			),
		]);
	} else {
		// 新規作成
		const result = await db
			.insert(pages)
			.values({
				category,
				unixName,
				title: body.title,
				source: body.source,
				revisionCount: 0,
				createdBy: user.id,
				updatedBy: user.id,
			})
			.returning({ id: pages.id });

		const pageId = result[0].id;

		const batchOps = [
			db.insert(revisions).values({
				pageId,
				revisionNumber: 0,
				title: body.title,
				source: body.source,
				comment: body.comment,
				createdBy: user.id,
			}),
			...body.tags.map((tag) =>
				db.insert(pageTags).values({ pageId, tag }),
			),
		];

		if (batchOps.length > 0) {
			await db.batch(batchOps as [typeof batchOps[0], ...typeof batchOps]);
		}
	}

	// レンダリング
	const rendered = await renderWikitext(body.source, c.env, {
		pageName: unixName,
		category,
		tags: body.tags,
	});

	return c.json({
		html: rendered.html,
		styles: rendered.styles,
	});
});

// ページ削除
api.delete("/page/*", requireAuth, async (c) => {
	const pagePath = c.req.path.replace("/api/page/", "");
	const [category, unixName] = parsePagePath(pagePath);
	const db = drizzle(c.env.DB);

	const page = await db
		.select({ id: pages.id, isLocked: pages.isLocked })
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}

	if (page[0].isLocked) {
		return c.json({ error: "Page is locked" }, 403);
	}

	await db.delete(pages).where(eq(pages.id, page[0].id));

	return c.json({ ok: true });
});

// リビジョン履歴
api.get("/page-history/*", async (c) => {
	const pagePath = c.req.path.replace("/api/page-history/", "");
	const [category, unixName] = parsePagePath(pagePath);
	const db = drizzle(c.env.DB);

	const page = await db
		.select({ id: pages.id })
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}

	const revs = await db
		.select()
		.from(revisions)
		.where(eq(revisions.pageId, page[0].id))
		.orderBy(revisions.revisionNumber);

	return c.json({ revisions: revs });
});

// プレビュー（保存せずにレンダリング）
const previewSchema = z.object({
	source: z.string(),
	page_name: z.string().default("preview"),
	category: z.string().default("_default"),
});

api.post("/preview", zValidator("json", previewSchema), async (c) => {
	const body = c.req.valid("json");
	const result = await renderWikitext(body.source, c.env, {
		pageName: body.page_name,
		category: body.category,
	});
	return c.json(result);
});

// 現在のユーザー情報
api.get("/me", async (c) => {
	const user = c.get("user");
	if (!user) {
		return c.json({ authenticated: false });
	}
	return c.json({ authenticated: true, user });
});

// サイドバー
api.get("/sidebar", async (c) => {
	const db = drizzle(c.env.DB);
	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, "nav"), eq(pages.unixName, "side")))
		.limit(1);

	if (!page[0]) {
		return c.json({ html: "", styles: [] });
	}

	const result = await renderWikitext(page[0].source, c.env, {
		pageName: "side",
		category: "nav",
	});
	return c.json(result);
});

// トップバー
api.get("/topbar", async (c) => {
	const db = drizzle(c.env.DB);
	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, "nav"), eq(pages.unixName, "top")))
		.limit(1);

	if (!page[0]) {
		return c.json({ html: "", styles: [] });
	}

	const result = await renderWikitext(page[0].source, c.env, {
		pageName: "top",
		category: "nav",
	});
	return c.json(result);
});

export { api };
