import { monotonicFactory } from "ulidx";

const ulidFactory = monotonicFactory();

export type Visibility = "public" | "share" | "private";

/**
 * カテゴリごとの振る舞いを一箇所に集約したポリシー。
 * 「private 以外は public 相当」を基本に、ULID 採番が必要か（public/share/private のみ）、
 * include 可否（private は不可）、ListPages 掲載（public 系のみ）、リビジョン記録時の
 * visibility 値などを 1 つの関数で返す。
 */
export type Policy = {
	visibility: Visibility;
	canInclude: boolean;
	isListable: boolean;
	requiresUlid: boolean;
	revisionVisibility: "share" | "private";
};

export function visibilityPolicy(category: string): Policy {
	if (category === "private") {
		return {
			visibility: "private",
			canInclude: false,
			isListable: false,
			requiresUlid: true,
			revisionVisibility: "private",
		};
	}
	if (category === "share") {
		return {
			visibility: "share",
			canInclude: true,
			isListable: false,
			requiresUlid: true,
			revisionVisibility: "share",
		};
	}
	if (category === "public") {
		return {
			visibility: "public",
			canInclude: true,
			isListable: true,
			requiresUlid: true,
			revisionVisibility: "share",
		};
	}
	// その他（nav / _default / 任意の固定パスカテゴリ）は public 相当だが ULID は不要
	return {
		visibility: "public",
		canInclude: true,
		isListable: true,
		requiresUlid: false,
		revisionVisibility: "share",
	};
}

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
 * categoryからvisibilityを判定する（policy ラッパー）。
 */
export function getVisibility(category: string, _unixName: string): Visibility {
	return visibilityPolicy(category).visibility;
}

export function isPrivate(category: string): boolean {
	return category === "private";
}

/**
 * ULID 採番が必要な category かどうか（public/share/private）。
 * 固定パスのカテゴリ（nav, _default 等）は false。
 */
export function isUlidCategory(category: string): boolean {
	return visibilityPolicy(category).requiresUlid;
}

/**
 * 新規作成API用: category + unix_name が ULID 採番カテゴリ + 正しい ULID であるか判定。
 */
export function isValidPageIdentifier(category: string, unixName: string): boolean {
	if (!isUlidCategory(category)) return false;
	return isValidUlid(unixName);
}

/**
 * 編集権限:
 *   - private: 作成者のみ
 *   - それ以外 (public/share/nav/_default/任意): ログインユーザー全員
 */
export function canEditPage(
	page: { category: string; unixName: string; createdBy: number | null },
	viewerId: number | null,
): boolean {
	if (viewerId === null) return false;
	if (visibilityPolicy(page.category).visibility === "private") {
		return page.createdBy === viewerId;
	}
	return true;
}

/**
 * 削除・トグル権限: ULID 採番済みの public/share/private のみ、
 * かつ unix_name が正しい ULID 形式かつ作成者本人のみ。
 * 固定パスカテゴリ (nav/_default/任意) は管理機能なし（wrangler/D1経由）。
 */
export function canManagePage(
	page: { category: string; unixName: string; createdBy: number | null },
	viewerId: number | null,
): boolean {
	if (viewerId === null) return false;
	if (!isUlidCategory(page.category)) return false;
	if (!isValidUlid(page.unixName)) return false;
	return page.createdBy === viewerId;
}

/**
 * revisions.visibility カラム用の正規化（policy ラッパー）。
 * 'share' | 'private' の2値に絞り、private のときだけ owner 限定にする。
 */
export function toRevisionVisibility(category: string): "share" | "private" {
	return visibilityPolicy(category).revisionVisibility;
}

/**
 * 閲覧権限: private は作成者のみ、それ以外 は誰でも。
 */
export function canViewPage(
	page: { category: string; unixName: string; createdBy: number | null },
	viewerId: number | null,
): boolean {
	if (visibilityPolicy(page.category).visibility === "private") {
		return viewerId !== null && page.createdBy === viewerId;
	}
	return true;
}
