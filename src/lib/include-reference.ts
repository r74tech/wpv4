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

export type LocalIncludeTarget = {
	category: string | null;
	unixName: string;
};

/** WDPRが解析したinclude先をwpv4のD1 lookup対象へ変換する。 */
export function resolveLocalIncludeTarget(pageRef: PageRef): LocalIncludeTarget | null {
	const cleaned = pageRef.page.replace(/^\/+|\/+$/g, "");
	const pageSegment = cleaned.split("/")[0] ?? "";
	const separatorIndex = pageSegment.search(/[:;]/);
	const unixName = separatorIndex === -1 ? pageSegment : pageSegment.slice(separatorIndex + 1);
	if (!unixName) return null;

	if (isValidUlid(unixName)) {
		return { category: null, unixName: normalizeUlid(unixName) };
	}
	return {
		category: separatorIndex === -1 ? null : pageSegment.slice(0, separatorIndex),
		unixName,
	};
}
