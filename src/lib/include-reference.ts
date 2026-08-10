import type { PageRef } from "@wdprlib/ast";
import { isValidUlid, normalizeUlid } from "./visibility";

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
