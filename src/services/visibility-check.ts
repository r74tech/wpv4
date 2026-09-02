import { extractIncludeReferences } from "@wdprlib/parser";
import { drizzle } from "drizzle-orm/d1";
import { ne, and, sql, isNull } from "drizzle-orm";
import { pages } from "@/db/schema";
import { canViewPage, normalizeUlid } from "@/lib/visibility";
import { resolveLocalIncludeUnixName } from "@/lib/include-reference";

type DrizzleD1 = ReturnType<typeof drizzle>;

export type ReferencingResult = {
	visible: Array<{ id: number; category: string; unixName: string; title: string }>;
	hiddenCount: number;
};

/**
 * 指定ULIDをincludeで参照している他ページのリストを返す。
 * - 1段目: pages.source LIKE で候補抽出（小文字統一）
 * - 2段目: WDPRでdirect includeを解析し、実際のlocal fetch targetと比較
 * - 3段目: viewer から見えないページ（他人private）は hiddenCount にだけ加算
 */
export async function findReferencingPages(
	db: DrizzleD1,
	ulid: string,
	selfId: number,
	viewerId: number | null,
): Promise<ReferencingResult> {
	const targetUnixName = normalizeUlid(ulid);
	const candidates = await db
		.select({
			id: pages.id,
			category: pages.category,
			unixName: pages.unixName,
			title: pages.title,
			source: pages.source,
			createdBy: pages.createdBy,
		})
		.from(pages)
		.where(
			and(
				sql`lower(${pages.source}) LIKE '%' || ${targetUnixName} || '%'`,
				ne(pages.id, selfId),
				isNull(pages.deletedAt),
			),
		);

	const visible: ReferencingResult["visible"] = [];
	let hiddenCount = 0;

	for (const c of candidates) {
		const referencesTarget = extractIncludeReferences(c.source ?? "").some(
			(reference) => resolveLocalIncludeUnixName(reference.location) === targetUnixName,
		);
		if (!referencesTarget) continue;
		const canView = canViewPage(c, viewerId);
		if (canView) {
			visible.push({ id: c.id, category: c.category, unixName: c.unixName, title: c.title });
		} else {
			hiddenCount++;
		}
	}

	return { visible, hiddenCount };
}
