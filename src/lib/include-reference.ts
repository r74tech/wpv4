import type { PageRef } from "@wdprlib/ast";
import { isValidUlid, normalizeUlid } from "./visibility";

/** PageRefをinclude先Source APIで扱うpathへ変換する。 */
export function formatIncludeSourcePath(pageRef: PageRef): string {
	const page = pageRef.page.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
	if (!page) return "";

	return pageRef.site ? `:${pageRef.site}:${page}` : page;
}

/** include先Source APIのpathをWDPRと同じPageRef表現へ戻す。 */
export function parseIncludeSourcePath(path: string): PageRef {
	if (path.startsWith(":")) {
		const siteEnd = path.indexOf(":", 1);
		if (siteEnd !== -1) {
			return {
				site: path.slice(1, siteEnd),
				page: path.slice(siteEnd + 1),
			};
		}
	}

	return { site: null, page: path };
}

/**
 * WDPRが解析したinclude先を、wpv4のD1 lookupで使うlocal unix_nameへ変換する。
 * site指定とcategory、URL suffixはDB lookupに使わず、ULIDだけは全入口の規約どおり
 * 小文字へ正規化する。
 */
export function resolveLocalIncludeUnixName(pageRef: PageRef): string | null {
	const cleaned = pageRef.page.replace(/^\/+|\/+$/g, "");
	const pageSegment = cleaned.split("/")[0] ?? "";
	const separatorIndex = pageSegment.search(/[:;]/);
	const unixName = separatorIndex === -1 ? pageSegment : pageSegment.slice(separatorIndex + 1);
	if (!unixName) return null;

	return isValidUlid(unixName) ? normalizeUlid(unixName) : unixName;
}
