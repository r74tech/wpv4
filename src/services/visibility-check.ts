import { drizzle } from "drizzle-orm/d1";
import { eq, ne, and, sql } from "drizzle-orm";
import { pages } from "@/db/schema";
import { canViewPage } from "@/lib/visibility";

type DrizzleD1 = ReturnType<typeof drizzle>;

export type ReferencingResult = {
	visible: Array<{ id: number; category: string; unixName: string; title: string }>;
	hiddenCount: number;
};

// [[include ... <ulid> ...]] にマッチする正規表現を ulid 毎に生成
function includeMatcher(ulid: string): RegExp {
	const escaped = ulid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\[\\[include\\s[^\\]]*${escaped}[^\\]]*\\]\\]`, "im");
}

/**
 * 指定ULIDをincludeで参照している他ページのリストを返す。
 * - 1段目: pages.source LIKE で候補抽出（小文字統一）
 * - 2段目: 正規表現で [[include ... <ulid> ...]] にマッチするか実検証
 * - 3段目: viewer から見えないページ（他人private）は hiddenCount にだけ加算
 */
export async function findReferencingPages(
	db: DrizzleD1,
	ulid: string,
	selfId: number,
	viewerId: number | null,
): Promise<ReferencingResult> {
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
		.where(and(sql`lower(${pages.source}) LIKE '%' || ${ulid} || '%'`, ne(pages.id, selfId)));

	const matcher = includeMatcher(ulid);
	const visible: ReferencingResult["visible"] = [];
	let hiddenCount = 0;

	for (const c of candidates) {
		if (!matcher.test(c.source ?? "")) continue;
		const canView = canViewPage(c, viewerId);
		if (canView) {
			visible.push({ id: c.id, category: c.category, unixName: c.unixName, title: c.title });
		} else {
			hiddenCount++;
		}
	}

	return { visible, hiddenCount };
}

// 未使用回避（eq import 維持のため。将来拡張用）
void eq;
