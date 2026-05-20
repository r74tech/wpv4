import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { pages, revisions, pageTags, users } from "@/db/schema";
import { renderWikitext, parsePagePath } from "@/services/pipeline";
import { renderNav } from "@/services/nav";
import { requireAuth } from "@/middleware/session";
import { verifyCsrf } from "@/middleware/csrf";
import {
	canEditPage,
	canManagePage,
	canViewPage,
	generateUlid,
	getVisibility,
	isPrivate,
	isShare,
	isValidPageIdentifier,
	isValidUlid,
	normalizeUlid,
} from "@/lib/visibility";
import { findReferencingPages } from "@/services/visibility-check";
import type { AppEnv } from "@/types/env";

const api = new Hono<AppEnv>();

// 変更系APIにCSRF + 認証ミドルウェアを適用
api.use("*", verifyCsrf);

// パス文字列を [category, unixName] に分解し、share/private なら unix_name を小文字統一
function parseAndNormalize(pagePath: string): [string, string] {
	const [category, unixName] = parsePagePath(pagePath);
	if (isShare(category) || isPrivate(category)) {
		return [category, normalizeUlid(unixName)];
	}
	return [category, unixName];
}

// ページ取得（レンダリング済みHTML）
api.get("/page/*", async (c) => {
	const pagePath = c.req.path.replace("/api/page/", "");
	const [category, unixName] = parseAndNormalize(pagePath);
	const viewerId = c.get("user")?.id ?? null;
	const db = drizzle(c.env.DB);

	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}
	if (!canViewPage(page[0], viewerId)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	const tags = await db
		.select({ tag: pageTags.tag })
		.from(pageTags)
		.where(eq(pageTags.pageId, page[0].id));

	const result = await renderWikitext(page[0].source, c.env, {
		pageName: unixName,
		category,
		tags: tags.map((t) => t.tag),
		viewerId,
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
		visibility: getVisibility(page[0].category, page[0].unixName),
		viewer_is_owner: viewerId !== null && page[0].createdBy === viewerId,
		can_edit: canEditPage(page[0], viewerId),
		can_manage: canManagePage(page[0], viewerId),
		created_by: page[0].createdBy,
		is_locked: page[0].isLocked === 1,
	});
});

// ソース取得（編集用）
api.get("/page-source/*", async (c) => {
	const pagePath = c.req.path.replace("/api/page-source/", "");
	const [category, unixName] = parseAndNormalize(pagePath);
	const viewerId = c.get("user")?.id ?? null;
	const db = drizzle(c.env.DB);

	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}
	if (!canViewPage(page[0], viewerId)) {
		return c.json({ error: "Forbidden" }, 403);
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

// 新規ページ作成（share/private専用、ULID自動採番）
const newPageSchema = z.object({
	type: z.enum(["share", "private"]),
	title: z.string(),
	source: z.string(),
	tags: z.array(z.string()).default([]),
	comment: z.string().default(""),
});

api.post("/page/new", requireAuth, zValidator("json", newPageSchema), async (c) => {
	const body = c.req.valid("json");
	const user = c.get("user")!;
	const db = drizzle(c.env.DB);

	const ulid = generateUlid();
	if (!isValidPageIdentifier(body.type, ulid)) {
		return c.json({ error: "Internal: invalid identifier" }, 500);
	}

	// タグ重複除去（UI dedupeに頼らない、UNIQUE(page_id,tag) 違反を未然に防ぐ）
	const uniqueTags = Array.from(new Set(body.tags.map((t) => t.trim()).filter(Boolean)));

	const result = await db
		.insert(pages)
		.values({
			category: body.type,
			unixName: ulid,
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
		...uniqueTags.map((tag) => db.insert(pageTags).values({ pageId, tag })),
	];

	if (batchOps.length > 0) {
		await db.batch(batchOps as [(typeof batchOps)[0], ...typeof batchOps]);
	}

	const rendered = await renderWikitext(body.source, c.env, {
		pageName: ulid,
		category: body.type,
		tags: body.tags,
		viewerId: user.id,
	});

	return c.json({
		path: `${body.type}:${ulid}`,
		html: rendered.html,
		styles: rendered.styles,
	});
});

// ページ更新（既存ページのみ。新規作成は POST /api/page/new）
const updatePageSchema = z.object({
	title: z.string(),
	source: z.string(),
	tags: z.array(z.string()).default([]),
	comment: z.string().default(""),
	base_revision_number: z.number(),
});

api.put("/page/*", requireAuth, zValidator("json", updatePageSchema), async (c) => {
	const pagePath = c.req.path.replace("/api/page/", "");
	const [category, unixName] = parseAndNormalize(pagePath);
	const body = c.req.valid("json");
	const user = c.get("user")!;
	const db = drizzle(c.env.DB);

	const existing = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	const page = existing[0];
	if (!page) {
		return c.json({ error: "Page not found" }, 404);
	}
	if (!canEditPage(page, user.id)) {
		return c.json({ error: "Forbidden" }, 403);
	}
	if (page.isLocked) {
		return c.json({ error: "Page is locked" }, 403);
	}
	if (page.revisionCount !== body.base_revision_number) {
		return c.json({ error: "Conflict: page has been modified" }, 409);
	}

	const newRevisionNumber = (page.revisionCount ?? 0) + 1;
	const uniqueTags = Array.from(new Set(body.tags.map((t) => t.trim()).filter(Boolean)));

	// UPDATE は category と revisionCount を WHERE 条件に含め、競合（toggle/同時編集）を検出する
	const updateResult = await db
		.update(pages)
		.set({
			title: body.title,
			source: body.source,
			revisionCount: newRevisionNumber,
			updatedBy: user.id,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(pages.id, page.id),
				eq(pages.category, page.category),
				eq(pages.revisionCount, body.base_revision_number),
			),
		)
		.returning({ id: pages.id });

	if (updateResult.length === 0) {
		// 並行 toggle / 同時編集により条件不一致。クライアントには再取得を要求する 409 を返す
		return c.json({ error: "Conflict: page was modified concurrently" }, 409);
	}

	// UPDATE 成功後にのみ revision / tag を更新する
	await db.batch([
		db.insert(revisions).values({
			pageId: page.id,
			revisionNumber: newRevisionNumber,
			title: body.title,
			source: body.source,
			comment: body.comment,
			createdBy: user.id,
		}),
		db.delete(pageTags).where(eq(pageTags.pageId, page.id)),
		...uniqueTags.map((tag) => db.insert(pageTags).values({ pageId: page.id, tag })),
	]);

	const rendered = await renderWikitext(body.source, c.env, {
		pageName: unixName,
		category,
		tags: body.tags,
		viewerId: user.id,
	});

	return c.json({
		html: rendered.html,
		styles: rendered.styles,
	});
});

// visibility トグル（share ↔ private）
const visibilitySchema = z.object({
	target: z.enum(["share", "private"]),
	force: z.boolean().optional().default(false),
});

api.post("/page/:ulid/visibility", requireAuth, zValidator("json", visibilitySchema), async (c) => {
	const ulidRaw = c.req.param("ulid");
	const ulid = normalizeUlid(ulidRaw);
	if (!isValidUlid(ulid)) {
		return c.json({ error: "Invalid ULID" }, 400);
	}
	const body = c.req.valid("json");
	const user = c.get("user")!;
	const db = drizzle(c.env.DB);

	// unix_name UNIQUE で一意特定
	const page = await db.select().from(pages).where(eq(pages.unixName, ulid)).limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}
	if (!canManagePage(page[0], user.id)) {
		return c.json({ error: "Forbidden" }, 403);
	}
	if (page[0].isLocked) {
		return c.json({ error: "Page is locked" }, 403);
	}
	if (page[0].category === body.target) {
		return c.json({ error: "Already in target visibility" }, 400);
	}

	// share→private のときだけ include 被参照を検出
	if (body.target === "private") {
		const refs = await findReferencingPages(db, ulid, page[0].id, user.id);
		if (!body.force && (refs.visible.length > 0 || refs.hiddenCount > 0)) {
			return c.json(
				{
					error: "Page is referenced by other pages",
					referenced_by: refs.visible.map((r) => ({
						category: r.category,
						unix_name: r.unixName,
						title: r.title,
					})),
					hidden_referenced_count: refs.hiddenCount,
				},
				409,
			);
		}
	}

	// rename(toggle) も revision として記録する
	const newRevisionNumber = (page[0].revisionCount ?? 0) + 1;
	const comment = `Changed visibility to ${body.target}`;

	const updateResult = await db
		.update(pages)
		.set({
			category: body.target,
			revisionCount: newRevisionNumber,
			updatedBy: user.id,
			updatedAt: new Date().toISOString(),
		})
		.where(and(eq(pages.id, page[0].id), eq(pages.category, page[0].category)))
		.returning({ id: pages.id });

	if (updateResult.length === 0) {
		// 並行トグルにより既に category が変わっていた
		return c.json({ error: "Conflict: page was modified concurrently" }, 409);
	}

	await db.insert(revisions).values({
		pageId: page[0].id,
		revisionNumber: newRevisionNumber,
		title: page[0].title,
		source: page[0].source,
		comment,
		createdBy: user.id,
	});

	return c.json({
		ok: true,
		new_path: `${body.target}:${ulid}`,
	});
});

// ページ削除
api.delete("/page/*", requireAuth, async (c) => {
	const pagePath = c.req.path.replace("/api/page/", "");
	const [category, unixName] = parseAndNormalize(pagePath);
	const user = c.get("user")!;
	const db = drizzle(c.env.DB);

	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}

	if (!canManagePage(page[0], user.id)) {
		return c.json({ error: "Forbidden" }, 403);
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
	const [category, unixName] = parseAndNormalize(pagePath);
	const viewerId = c.get("user")?.id ?? null;
	const db = drizzle(c.env.DB);

	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}
	if (!canViewPage(page[0], viewerId)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	const revs = await db
		.select()
		.from(revisions)
		.where(eq(revisions.pageId, page[0].id))
		.orderBy(revisions.revisionNumber);

	return c.json({ revisions: revs });
});

// 特定リビジョン取得
api.get("/page-revision/*/r/:num", async (c) => {
	const fullPath = c.req.path.replace("/api/page-revision/", "");
	// 末尾の /r/:num を切り離す
	const m = fullPath.match(/^(.+)\/r\/(\d+)$/);
	if (!m) {
		return c.json({ error: "Invalid path" }, 400);
	}
	const pagePath = m[1];
	const revNum = Number(m[2]);
	const [category, unixName] = parseAndNormalize(pagePath);
	const viewerId = c.get("user")?.id ?? null;
	const db = drizzle(c.env.DB);

	const page = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName)))
		.limit(1);

	if (!page[0]) {
		return c.json({ error: "Page not found" }, 404);
	}
	if (!canViewPage(page[0], viewerId)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	const rev = await db
		.select({
			revisionNumber: revisions.revisionNumber,
			title: revisions.title,
			source: revisions.source,
			comment: revisions.comment,
			createdBy: revisions.createdBy,
			createdAt: revisions.createdAt,
			createdByName: users.name,
			createdByUnixName: users.unixName,
		})
		.from(revisions)
		.leftJoin(users, eq(users.id, revisions.createdBy))
		.where(and(eq(revisions.pageId, page[0].id), eq(revisions.revisionNumber, revNum)))
		.limit(1);

	if (!rev[0]) {
		return c.json({ error: "Revision not found" }, 404);
	}

	return c.json({
		revision_number: rev[0].revisionNumber,
		title: rev[0].title,
		source: rev[0].source,
		comment: rev[0].comment,
		created_by: rev[0].createdBy,
		created_by_name: rev[0].createdByName,
		created_by_unix_name: rev[0].createdByUnixName,
		created_at: rev[0].createdAt,
		page_path: `${page[0].category}:${page[0].unixName}`,
	});
});

// プレビュー（保存せずにレンダリング）
const previewSchema = z.object({
	source: z.string(),
	page_name: z.string().default("preview"),
	category: z.string().default("_default"),
});

api.post("/preview", zValidator("json", previewSchema), async (c) => {
	const body = c.req.valid("json");
	const viewerId = c.get("user")?.id ?? null;
	const result = await renderWikitext(body.source, c.env, {
		pageName: body.page_name,
		category: body.category,
		viewerId,
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
	const viewerId = c.get("user")?.id ?? null;
	const result = await renderNav(c.env, "side", viewerId);
	return c.json(result ?? { html: "", styles: [] });
});

// トップバー
api.get("/topbar", async (c) => {
	const viewerId = c.get("user")?.id ?? null;
	const result = await renderNav(c.env, "top", viewerId);
	return c.json(result ?? { html: "", styles: [] });
});

export { api };
