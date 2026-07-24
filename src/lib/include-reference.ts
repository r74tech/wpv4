import type { PageRef } from "@wdprlib/ast";
import { isValidUlid, normalizeUlid } from "./visibility";

/**
 * WDPRが解析したinclude先を、wpv4のD1 lookupで使うlocal unix_nameへ変換する。
 * cross-site参照は取得対象外。categoryとURL suffixはDB lookupに使わず、ULIDだけは
 * 全入口の規約どおり小文字へ正規化する。
 */
export function resolveLocalIncludeUnixName(pageRef: PageRef): string | null {
	if (pageRef.site !== null) return null;

	const cleaned = pageRef.page.replace(/^\/+|\/+$/g, "");
	const pageSegment = cleaned.split("/")[0] ?? "";
	const colonIndex = pageSegment.indexOf(":");
	const unixName = colonIndex === -1 ? pageSegment : pageSegment.slice(colonIndex + 1);
	if (!unixName) return null;

	return isValidUlid(unixName) ? normalizeUlid(unixName) : unixName;
}
