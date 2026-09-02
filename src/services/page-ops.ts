import { and, eq, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { pages } from "@/db/schema";
import {
	canEditPage,
	canManagePage,
	generateUlid,
	toRevisionVisibility,
	type Visibility as PageVisibility,
} from "@/lib/visibility";
import { findReferencingPages } from "@/services/visibility-check";
import { moveHtmlBlocksForVisibilityChange, restoreMovedHtmlBlocks } from "@/services/pipeline";

type Db = ReturnType<typeof drizzle>;
type Page = typeof pages.$inferSelect;

export type PageOperationError =
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "forbidden" }
	| { ok: false; reason: "locked" }
	| { ok: false; reason: "already_target" }
	| { ok: false; reason: "conflict"; currentRevisionNumber?: number; actualCategory?: string }
	| {
			ok: false;
			reason: "impact";
			referencedBy: Array<{ category: string; unixName: string; title: string }>;
			hiddenReferencedCount: number;
			includeBecomesBroken: boolean;
			listPagesPresenceChanges: boolean;
	  }
	| { ok: false; reason: "internal" };

export function normalizePageTags(tags: string[]): string[] {
	return [
		...new Set(
			tags
				.flatMap((tag) => tag.split(/[\s,]+/))
				.map((tag) => tag.trim())
				.filter(Boolean),
		),
	];
}

async function loadPage(db: Db, category: string, unixName: string): Promise<Page | null> {
	const rows = await db
		.select()
		.from(pages)
		.where(and(eq(pages.category, category), eq(pages.unixName, unixName), isNull(pages.deletedAt)))
		.limit(1);
	return rows[0] ?? null;
}

function resultRows(result: D1Result<unknown>): unknown[] {
	return Array.isArray(result.results) ? result.results : [];
}

export async function createPage(
	db: Db,
	input: {
		type: PageVisibility;
		title: string;
		source: string;
		tags: string[];
		comment: string;
		userId: number;
		now: Date;
		generateId?: () => string;
	},
): Promise<{
	ok: true;
	pageId: number;
	path: string;
	unixName: string;
	tags: string[];
	revisionNumber: 0;
}> {
	const unixName = (input.generateId ?? generateUlid)();
	const tags = normalizePageTags(input.tags);
	const now = input.now.toISOString();
	const statements = [
		db.$client
			.prepare(
				`INSERT INTO pages
					(category, unix_name, title, source, revision_count, created_by, updated_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
				 RETURNING id`,
			)
			.bind(input.type, unixName, input.title, input.source, input.userId, input.userId, now, now),
		db.$client
			.prepare(
				`INSERT INTO revisions
					(page_id, revision_number, title, source, comment, visibility, created_by, created_at)
				 SELECT id, 0, ?, ?, ?, ?, ?, ? FROM pages WHERE unix_name = ?`,
			)
			.bind(
				input.title,
				input.source,
				input.comment,
				toRevisionVisibility(input.type),
				input.userId,
				now,
				unixName,
			),
		...tags.map((tag) =>
			db.$client
				.prepare("INSERT INTO page_tags (page_id, tag) SELECT id, ? FROM pages WHERE unix_name = ?")
				.bind(tag, unixName),
		),
	];
	const results = await db.$client.batch(statements);
	const pageId = Number((resultRows(results[0])[0] as { id?: unknown } | undefined)?.id);
	if (!Number.isInteger(pageId)) throw new Error("Page creation did not return an id");
	return { ok: true, pageId, path: `${input.type}:${unixName}`, unixName, tags, revisionNumber: 0 };
}

export async function updatePage(
	db: Db,
	input: {
		category: string;
		unixName: string;
		title: string;
		source: string;
		tags: string[];
		comment: string;
		baseRevisionNumber: number;
		userId: number;
		now: Date;
	},
): Promise<{ ok: true; page: Page; tags: string[]; revisionNumber: number } | PageOperationError> {
	const page = await loadPage(db, input.category, input.unixName);
	if (!page) return { ok: false, reason: "not_found" };
	if (!canEditPage(page, input.userId)) return { ok: false, reason: "forbidden" };
	if (page.isLocked) return { ok: false, reason: "locked" };
	if ((page.revisionCount ?? 0) !== input.baseRevisionNumber) {
		return { ok: false, reason: "conflict", currentRevisionNumber: page.revisionCount ?? 0 };
	}

	const tags = normalizePageTags(input.tags);
	const revisionNumber = input.baseRevisionNumber + 1;
	const guardParams = [page.id, page.category, input.baseRevisionNumber];
	const guard =
		"id = ? AND category = ? AND revision_count = ? AND is_locked = 0 AND deleted_at IS NULL";
	const existsGuard = `EXISTS (SELECT 1 FROM pages WHERE ${guard})`;
	const now = input.now.toISOString();
	const statements = [
		db.$client
			.prepare(
				`INSERT INTO revisions
					(page_id, revision_number, title, source, comment, visibility, created_by, created_at)
				 SELECT id, ?, ?, ?, ?, ?, ?, ? FROM pages WHERE ${guard}`,
			)
			.bind(
				revisionNumber,
				input.title,
				input.source,
				input.comment,
				toRevisionVisibility(page.category),
				input.userId,
				now,
				...guardParams,
			),
		db.$client
			.prepare(`DELETE FROM page_tags WHERE page_id = ? AND ${existsGuard}`)
			.bind(page.id, ...guardParams),
		...tags.map((tag) =>
			db.$client
				.prepare(`INSERT INTO page_tags (page_id, tag) SELECT ?, ? WHERE ${existsGuard}`)
				.bind(page.id, tag, ...guardParams),
		),
		db.$client
			.prepare(
				`UPDATE pages
				 SET title = ?, source = ?, revision_count = ?, updated_by = ?, updated_at = ?
				 WHERE ${guard}
				 RETURNING id`,
			)
			.bind(input.title, input.source, revisionNumber, input.userId, now, ...guardParams),
	];
	const results = await db.$client.batch(statements);
	if (resultRows(results.at(-1)!).length === 0) {
		const current = await loadPage(db, input.category, input.unixName);
		return {
			ok: false,
			reason: "conflict",
			currentRevisionNumber: current?.revisionCount ?? undefined,
		};
	}
	return { ok: true, page, tags, revisionNumber };
}

export async function deletePage(
	db: Db,
	input: { category: string; unixName: string; userId: number; now: Date },
): Promise<{ ok: true; pageId: number; deletedAt: string } | PageOperationError> {
	const page = await loadPage(db, input.category, input.unixName);
	if (!page) return { ok: false, reason: "not_found" };
	if (!canManagePage(page, input.userId)) return { ok: false, reason: "forbidden" };
	if (page.isLocked) return { ok: false, reason: "locked" };
	const deletedAt = input.now.toISOString();
	const rows = await db
		.update(pages)
		.set({
			deletedAt,
			deletedBy: input.userId,
			updatedAt: input.now.toISOString(),
			updatedBy: input.userId,
		})
		.where(
			and(
				eq(pages.id, page.id),
				eq(pages.category, page.category),
				eq(pages.revisionCount, page.revisionCount ?? 0),
				eq(pages.isLocked, 0),
				isNull(pages.deletedAt),
			),
		)
		.returning({ id: pages.id });
	return rows.length === 0
		? { ok: false, reason: "conflict" }
		: { ok: true, pageId: page.id, deletedAt };
}

async function writeVisibilityChange(
	db: Db,
	page: Page,
	input: { target: PageVisibility; userId: number; now: Date },
): Promise<number | null> {
	const baseRevision = page.revisionCount ?? 0;
	const revisionNumber = baseRevision + 1;
	const now = input.now.toISOString();
	const guard =
		"id = ? AND category = ? AND revision_count = ? AND is_locked = 0 AND deleted_at IS NULL";
	const guardParams = [page.id, page.category, baseRevision];
	const statements = [
		db.$client
			.prepare(
				`INSERT INTO revisions
					(page_id, revision_number, title, source, comment, visibility, created_by, created_at)
				 SELECT id, ?, title, source, ?, ?, ?, ? FROM pages WHERE ${guard}`,
			)
			.bind(
				revisionNumber,
				`Changed visibility to ${input.target}`,
				toRevisionVisibility(input.target),
				input.userId,
				now,
				...guardParams,
			),
	];
	statements.push(
		db.$client
			.prepare(
				`UPDATE pages SET category = ?, revision_count = ?, updated_by = ?, updated_at = ?
				 WHERE ${guard} RETURNING id`,
			)
			.bind(input.target, revisionNumber, input.userId, now, ...guardParams),
	);
	const results = await db.$client.batch(statements);
	return resultRows(results.at(-1)!).length === 0 ? null : revisionNumber;
}

async function rollbackVisibilityChange(
	db: Db,
	page: Page,
	target: PageVisibility,
	userId: number,
	now: Date,
): Promise<boolean> {
	const timestamp = now.toISOString();
	const results = await db.$client.batch([
		db.$client
			.prepare(
				`INSERT INTO revisions
					(page_id, revision_number, title, source, comment, visibility, created_by, created_at)
				 SELECT id, revision_count + 1, title, source, ?, ?, ?, ?
					 FROM pages WHERE id = ? AND category = ? AND deleted_at IS NULL`,
			)
			.bind(
				`Rolled back visibility to ${page.category}`,
				toRevisionVisibility(page.category),
				userId,
				timestamp,
				page.id,
				target,
			),
		db.$client
			.prepare(
				`UPDATE pages SET category = ?, revision_count = revision_count + 1, updated_by = ?, updated_at = ?
					 WHERE id = ? AND category = ? AND deleted_at IS NULL RETURNING id`,
			)
			.bind(page.category, userId, timestamp, page.id, target),
	]);
	return resultRows(results[1]).length > 0;
}

async function retryVisibilityRollback(
	db: Db,
	page: Page,
	target: PageVisibility,
	userId: number,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
	for (const delay of [200, 400, 800]) {
		try {
			if (await rollbackVisibilityChange(db, page, target, userId, new Date())) return true;
		} catch (error) {
			console.error("Visibility rollback failed", error);
		}
		await sleep(delay);
	}
	return false;
}

async function closePublicHtmlBlocks(
	r2: R2Bucket,
	page: string,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
	let lastError: unknown;
	for (const delay of [0, 200, 400, 800]) {
		if (delay > 0) await sleep(delay);
		let deletionFailed = false;
		try {
			let cursor: string | undefined;
			do {
				const list = await r2.list({ prefix: `local--html/${page}/`, cursor });
				for (const object of list.objects) {
					try {
						const source = await r2.get(object.key);
						if (source) {
							const privateKey = object.key.replace("local--html/", "private--html/");
							await r2.put(privateKey, source.body, { httpMetadata: source.httpMetadata });
						}
					} catch (error) {
						console.error("Failed to preserve HTML block while closing public access", error);
					}
					try {
						// The DB still says private, so confidentiality takes priority over a public copy.
						await r2.delete(object.key);
					} catch (error) {
						deletionFailed = true;
						lastError = error;
						console.error("Failed to delete public HTML block", error);
					}
				}
				cursor = list.truncated ? list.cursor : undefined;
			} while (cursor);
			if (!deletionFailed) return;
		} catch (error) {
			lastError = error;
			console.error("Failed to list public HTML blocks", error);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Failed to close public HTML blocks");
}

export async function changePageVisibility(
	db: Db,
	r2: R2Bucket,
	input: {
		unixName: string;
		expectedCategory: PageVisibility;
		target: PageVisibility;
		force: boolean;
		userId: number;
		now: Date;
		sleep?: (milliseconds: number) => Promise<void>;
	},
): Promise<{ ok: true; page: Page; path: string; revisionNumber: number } | PageOperationError> {
	const rows = await db
		.select()
		.from(pages)
		.where(and(eq(pages.unixName, input.unixName), isNull(pages.deletedAt)))
		.limit(1);
	const page = rows[0];
	if (!page) return { ok: false, reason: "not_found" };
	if (!canManagePage(page, input.userId)) return { ok: false, reason: "forbidden" };
	if (page.isLocked) return { ok: false, reason: "locked" };
	if (page.category !== input.expectedCategory) {
		return { ok: false, reason: "conflict", actualCategory: page.category };
	}
	if (page.category === input.target) return { ok: false, reason: "already_target" };
	const currentVisibility = input.expectedCategory;

	const includeBecomesBroken = input.target === "private";
	const listPagesPresenceChanges = (page.category === "public") !== (input.target === "public");
	if ((includeBecomesBroken || listPagesPresenceChanges) && !input.force) {
		const refs = includeBecomesBroken
			? await findReferencingPages(db, input.unixName, page.id, input.userId)
			: { visible: [], hiddenCount: 0 };
		if (listPagesPresenceChanges || refs.visible.length > 0 || refs.hiddenCount > 0) {
			return {
				ok: false,
				reason: "impact",
				referencedBy: refs.visible,
				hiddenReferencedCount: refs.hiddenCount,
				includeBecomesBroken,
				listPagesPresenceChanges,
			};
		}
	}

	let firstSweep: string[] = [];
	if (input.target === "private") {
		firstSweep = await moveHtmlBlocksForVisibilityChange(
			r2,
			input.unixName,
			currentVisibility,
			"private",
		);
	}
	const revisionNumber = await writeVisibilityChange(db, page, input);
	if (revisionNumber === null) {
		if (firstSweep.length > 0) {
			const latest = await db
				.select({ category: pages.category })
				.from(pages)
				.where(and(eq(pages.id, page.id), isNull(pages.deletedAt)))
				.limit(1);
			if (latest[0]?.category === currentVisibility) {
				await restoreMovedHtmlBlocks(r2, firstSweep, currentVisibility, "private");
			}
		}
		return { ok: false, reason: "conflict" };
	}

	if (input.target === "private") {
		try {
			await moveHtmlBlocksForVisibilityChange(r2, input.unixName, currentVisibility, "private");
		} catch (error) {
			console.error("Post-visibility HTML block sweep failed", error);
			const sleep =
				input.sleep ??
				((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
			const rolledBack = await retryVisibilityRollback(db, page, input.target, input.userId, sleep);
			if (!rolledBack) {
				try {
					await closePublicHtmlBlocks(r2, input.unixName, sleep);
				} catch (closeError) {
					console.error("Failed to close public HTML blocks after rollback failure", closeError);
				}
			} else if (firstSweep.length > 0) {
				try {
					await restoreMovedHtmlBlocks(r2, firstSweep, currentVisibility, "private");
				} catch (restoreError) {
					console.error("Visibility HTML block rollback failed", restoreError);
				}
			}
			return { ok: false, reason: "internal" };
		}
	} else if (currentVisibility === "private") {
		try {
			await moveHtmlBlocksForVisibilityChange(r2, input.unixName, "private", input.target);
		} catch (error) {
			console.error("HTML block move after making page public failed", error);
			const sleep =
				input.sleep ??
				((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
			await retryVisibilityRollback(db, page, input.target, input.userId, sleep);
			return { ok: false, reason: "internal" };
		}
	}

	return { ok: true, page, path: `${input.target}:${input.unixName}`, revisionNumber };
}
