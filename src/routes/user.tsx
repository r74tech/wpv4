import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc, like, sql, and as drizzleAnd } from "drizzle-orm";
import { users, revisions, pages, passkeys } from "@/db/schema";
import { requireAuth } from "@/middleware/session";
import { authRenderer } from "@/auth-renderer";
import { SettingsPage } from "@/pages/auth/SettingsPage";
import { ActivitiesPage } from "@/pages/auth/ActivitiesPage";
import type { AppEnv } from "@/types/env";

const user = new Hono<AppEnv>();

user.use("*", requireAuth, authRenderer);

user.get("/settings", async (c) => {
	const currentUser = c.get("user")!;
	const db = drizzle(c.env.DB);

	const [userRow, userPasskeys] = await Promise.all([
		db.select().from(users).where(eq(users.id, currentUser.id)).limit(1),
		db
			.select({ id: passkeys.id, name: passkeys.name, createdAt: passkeys.createdAt })
			.from(passkeys)
			.where(eq(passkeys.userId, currentUser.id)),
	]);

	const u = userRow[0];
	if (!u) return c.notFound();

	return c.render(
		<SettingsPage
			user={{
				name: u.name,
				unixName: u.unixName,
				wikidotId: u.wikidotId,
				createdAt: u.createdAt,
				lastLoginAt: u.lastLoginAt,
			}}
			passkeys={userPasskeys}
		/>,
	);
});

user.get("/activities", async (c) => {
	const currentUser = c.get("user")!;
	const db = drizzle(c.env.DB);

	const page = Math.max(1, Number(c.req.query("page") ?? 1));
	const perPage = Math.min(100, Math.max(10, Number(c.req.query("per_page") ?? 20)));
	const search = c.req.query("q") ?? "";
	const offset = (page - 1) * perPage;

	const conditions = [eq(revisions.createdBy, currentUser.id)];
	if (search) {
		conditions.push(like(pages.unixName, `%${search}%`));
	}
	const whereClause = conditions.length === 1 ? conditions[0] : drizzleAnd(...conditions);

	const countResult = await db
		.select({ count: sql<number>`count(*)` })
		.from(revisions)
		.innerJoin(pages, eq(revisions.pageId, pages.id))
		.where(whereClause);
	const totalCount = countResult[0]?.count ?? 0;
	const totalPages = Math.ceil(totalCount / perPage);

	const rows = await db
		.select({
			revisionNumber: revisions.revisionNumber,
			title: revisions.title,
			comment: revisions.comment,
			createdAt: revisions.createdAt,
			category: pages.category,
			unixName: pages.unixName,
		})
		.from(revisions)
		.innerJoin(pages, eq(revisions.pageId, pages.id))
		.where(whereClause)
		.orderBy(desc(revisions.createdAt))
		.limit(perPage)
		.offset(offset);

	return c.render(
		<ActivitiesPage
			revisions={rows.map((r) => ({
				pagePath: `${r.category}:${r.unixName}`,
				revisionNumber: r.revisionNumber,
				title: r.title,
				comment: r.comment,
				createdAt: r.createdAt,
			}))}
			pagination={{ page, perPage, totalCount, totalPages }}
			search={search}
		/>,
	);
});

export { user };
