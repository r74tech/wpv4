import { monotonicFactory } from "ulidx";

const ulidFactory = monotonicFactory();

export type Visibility = "share" | "private" | "system";

/**
 * 新規ULID生成（必ず小文字）。
 * WDPR renderer の toLowerCase() と整合させるためDB保存・URL・全入口で小文字統一。
 */
export function generateUlid(): string {
	return ulidFactory().toLowerCase();
}

/**
 * 受け取った文字列を小文字化する。全入口（URL解析、API入力、include参照など）で必ず呼ぶ。
 */
export function normalizeUlid(s: string): string {
	return s.toLowerCase();
}

/**
 * ULID形式の妥当性チェック（Crockford Base32, 26文字、大小文字両対応）。
 * 検証OK後は normalizeUlid() で小文字化してDB lookupに使う。
 */
export function isValidUlid(s: string): boolean {
	return /^[0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{26}$/.test(s);
}

/**
 * categoryからvisibilityを判定する。
 * share/private/system 以外は null（未知カテゴリは呼び出し側で deny する）。
 * systemは限定列挙: nav:side, nav:top, _default:main の3パターンのみ。
 */
export function getVisibility(category: string, unixName: string): Visibility | null {
	if (category === "share") return "share";
	if (category === "private") return "private";
	if (category === "nav" && (unixName === "side" || unixName === "top")) return "system";
	if (category === "_default" && unixName === "main") return "system";
	return null;
}

export function isSystemPage(category: string, unixName: string): boolean {
	return getVisibility(category, unixName) === "system";
}

export function isShare(category: string): boolean {
	return category === "share";
}

export function isPrivate(category: string): boolean {
	return category === "private";
}

/**
 * カテゴリ + unix_name の組合せがアプリケーション層で許可された形式か判定。
 * INSERT前に呼び出して未知categoryを弾く。
 */
export function isValidPageIdentifier(category: string, unixName: string): boolean {
	const vis = getVisibility(category, unixName);
	if (vis === null) return false;
	if (vis === "system") return true;
	return isValidUlid(unixName);
}

/**
 * 編集権限: privateは作成者のみ、share/systemはログインユーザー全員、未知カテゴリはdeny。
 */
export function canEditPage(
	page: { category: string; unixName: string; createdBy: number | null },
	viewerId: number | null,
): boolean {
	if (viewerId === null) return false;
	const vis = getVisibility(page.category, page.unixName);
	if (vis === null) return false;
	if (vis === "private") return page.createdBy === viewerId;
	return true;
}

/**
 * 削除・トグル権限: share/private とも作成者のみ。system/未知はdeny。
 */
export function canManagePage(
	page: { category: string; unixName: string; createdBy: number | null },
	viewerId: number | null,
): boolean {
	if (viewerId === null) return false;
	const vis = getVisibility(page.category, page.unixName);
	if (vis !== "share" && vis !== "private") return false;
	return page.createdBy === viewerId;
}

/**
 * 閲覧権限: privateは作成者のみ、share/systemは誰でも、未知カテゴリはdeny。
 */
export function canViewPage(
	page: { category: string; unixName: string; createdBy: number | null },
	viewerId: number | null,
): boolean {
	const vis = getVisibility(page.category, page.unixName);
	if (vis === null) return false;
	if (vis === "private") return viewerId !== null && page.createdBy === viewerId;
	return true;
}
