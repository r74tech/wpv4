import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { pageTags, pages, revisions, users } from "@/db/schema";
import { canEditPage, canViewPage, toRevisionVisibility } from "@/lib/visibility";
import { requireAuth } from "@/middleware/session";
import type { AppEnv } from "@/types/env";
import { parseAndNormalize, routeSuffix } from "@/routes/page-path";

async function findPage(db: ReturnType<typeof drizzle>, pagePath: string) {
	const [category, unixName] = parseAndNormalize(pagePath);
	const rows = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName), isNull(pages.deletedAt)))
		.limit(1);
	return rows[0] ?? null;
}

function parseRevisionPath(
	fullPath: string | null | undefined,
): { pagePath: string; revisionNumber: number } | null {
	if (!fullPath) return null;
	const match = fullPath.match(/^(.+)\/r\/(\d+)$/);
	if (!match) return null;
	return { pagePath: match[1], revisionNumber: Number(match[2]) };
}

export const historyRoutes = new Hono<AppEnv>()
	.get("/page-history/*", async (c) => {
		const viewerId = c.get("user")?.id ?? null;
		const db = drizzle(c.env.DB);
		const pagePath = routeSuffix(c.req.path, "/page-history/");
		if (!pagePath) return c.json({ error: "Invalid path" }, 400);
		const page = await findPage(db, pagePath);
		if (!page) return c.json({ error: "Page not found" }, 404);
		if (!canViewPage(page, viewerId)) return c.json({ error: "Forbidden" }, 403);

		const rows = await db
			.select({
				revisionNumber: revisions.revisionNumber,
				title: revisions.title,
				comment: revisions.comment,
				visibility: revisions.visibility,
				createdBy: revisions.createdBy,
				createdAt: revisions.createdAt,
				createdByName: users.name,
				createdByUnixName: users.unixName,
				createdByWikidotId: users.wikidotId,
			})
			.from(revisions)
			.leftJoin(users, eq(users.id, revisions.createdBy))
			.where(eq(revisions.pageId, page.id))
			.orderBy(revisions.revisionNumber);
		const visibleRows =
			viewerId !== null && page.createdBy === viewerId
				? rows
				: rows.filter((revision) => revision.visibility !== "private");
		return c.json({
			currentRevision: page.revisionCount ?? 0,
			canEdit: canEditPage(page, viewerId),
			revisions: visibleRows.map((revision) => ({
				revisionNumber: revision.revisionNumber,
				title: revision.title,
				comment: revision.comment,
				createdBy: revision.createdBy,
				createdAt: revision.createdAt,
				createdByName: revision.createdByName,
				createdByUnixName: revision.createdByUnixName,
				createdByWikidotId: revision.createdByWikidotId,
			})),
		});
	})
	.get("/page-revision/*", async (c) => {
		const parsed = parseRevisionPath(routeSuffix(c.req.path, "/page-revision/"));
		if (!parsed) return c.json({ error: "Invalid path" }, 400);
		const viewerId = c.get("user")?.id ?? null;
		const db = drizzle(c.env.DB);
		const page = await findPage(db, parsed.pagePath);
		if (!page) return c.json({ error: "Page not found" }, 404);
		if (!canViewPage(page, viewerId)) return c.json({ error: "Forbidden" }, 403);

		const rows = await db
			.select({
				revisionNumber: revisions.revisionNumber,
				title: revisions.title,
				source: revisions.source,
				comment: revisions.comment,
				visibility: revisions.visibility,
				createdBy: revisions.createdBy,
				createdAt: revisions.createdAt,
				createdByName: users.name,
				createdByUnixName: users.unixName,
				createdByWikidotId: users.wikidotId,
			})
			.from(revisions)
			.leftJoin(users, eq(users.id, revisions.createdBy))
			.where(
				and(eq(revisions.pageId, page.id), eq(revisions.revisionNumber, parsed.revisionNumber)),
			)
			.limit(1);
		const revision = rows[0];
		if (!revision) return c.json({ error: "Revision not found" }, 404);
		if (revision.visibility === "private" && (viewerId === null || page.createdBy !== viewerId)) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const tags = await db
			.select({ tag: pageTags.tag })
			.from(pageTags)
			.where(eq(pageTags.pageId, page.id));
		return c.json({
			revision_number: revision.revisionNumber,
			title: revision.title,
			source: revision.source,
			comment: revision.comment,
			created_by: revision.createdBy,
			created_by_name: revision.createdByName,
			created_by_unix_name: revision.createdByUnixName,
			created_by_wikidot_id: revision.createdByWikidotId,
			created_at: revision.createdAt,
			page_path: `${page.category}:${page.unixName}`,
			tags: tags.map(({ tag }) => tag),
		});
	})
	.post("/page-revert/*", requireAuth, async (c) => {
		const parsed = parseRevisionPath(routeSuffix(c.req.path, "/page-revert/"));
		if (!parsed) return c.json({ error: "Invalid path" }, 400);
		const user = c.get("user")!;
		const db = drizzle(c.env.DB);
		const page = await findPage(db, parsed.pagePath);
		if (!page) return c.json({ error: "Page not found" }, 404);
		if (!canEditPage(page, user.id)) return c.json({ error: "Forbidden" }, 403);
		if (page.isLocked) return c.json({ error: "Page is locked" }, 403);
		if (parsed.revisionNumber === (page.revisionCount ?? 0)) {
			return c.json({ error: "Already at requested revision" }, 400);
		}

		const targets = await db
			.select({
				title: revisions.title,
				source: revisions.source,
				visibility: revisions.visibility,
			})
			.from(revisions)
			.where(
				and(eq(revisions.pageId, page.id), eq(revisions.revisionNumber, parsed.revisionNumber)),
			)
			.limit(1);
		const target = targets[0];
		if (!target) return c.json({ error: "Revision not found" }, 404);
		if (target.visibility === "private" && page.createdBy !== user.id) {
			return c.json({ error: "Forbidden" }, 403);
		}

		const revisionNumber = (page.revisionCount ?? 0) + 1;
		const now = new Date().toISOString();
		const guard =
			"id = ? AND revision_count = ? AND category = ? AND is_locked = 0 AND deleted_at IS NULL";
		const guardParams = [page.id, page.revisionCount ?? 0, page.category];
		const results = await db.$client.batch([
			db.$client
				.prepare(
					`INSERT INTO revisions
						(page_id, revision_number, title, source, comment, visibility, created_by, created_at)
					 SELECT id, ?, ?, ?, ?, ?, ?, ? FROM pages WHERE ${guard}`,
				)
				.bind(
					revisionNumber,
					target.title,
					target.source,
					`You successfully reverted the page to revision number ${parsed.revisionNumber}`,
					toRevisionVisibility(page.category),
					user.id,
					now,
					...guardParams,
				),
			db.$client
				.prepare(
					`UPDATE pages SET title = ?, source = ?, revision_count = ?, updated_by = ?, updated_at = ?
					 WHERE ${guard} RETURNING id`,
				)
				.bind(target.title, target.source, revisionNumber, user.id, now, ...guardParams),
		]);
		if (!Array.isArray(results[1].results) || results[1].results.length === 0) {
			return c.json({ error: "Conflict: page was modified concurrently" }, 409);
		}
		return c.json({
			ok: true,
			new_path: `${page.category}:${page.unixName}`,
			revision_number: revisionNumber,
		});
	});
