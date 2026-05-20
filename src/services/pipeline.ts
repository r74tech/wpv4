import {
	parse,
	resolveIncludesAsync,
	extractDataRequirements,
	resolveModules,
} from "@wdprlib/parser";
import type { DataProvider, ResolveOptions } from "@wdprlib/parser";
import { renderToHtml } from "@wdprlib/render";
import type { RenderOptions } from "@wdprlib/render";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, or } from "drizzle-orm";
import { pages, pageTags } from "@/db/schema";
import { getVisibility, isPrivate, isShare, normalizeUlid } from "@/lib/visibility";
import type { Bindings } from "@/types/env";

export type RenderResult = {
	html: string;
	styles: string[];
};

/**
 * viewer視点で公開対象になるページのみ含めるDrizzle WHERE 句を返す。
 * 限定列挙（getVisibility ベース）:
 *   - share: 誰でも
 *   - system: nav:side, nav:top, _default:main の3パターン限定
 *   - private: viewerId が created_by と一致する場合のみ
 *   - 未知カテゴリ: 一切除外
 */
function visibleByViewer(viewerId: number | null) {
	const shareCond = eq(pages.category, "share");
	const systemCond = or(
		and(eq(pages.category, "nav"), eq(pages.unixName, "side")),
		and(eq(pages.category, "nav"), eq(pages.unixName, "top")),
		and(eq(pages.category, "_default"), eq(pages.unixName, "main")),
	);
	if (viewerId === null) {
		return or(shareCond, systemCond);
	}
	return or(
		shareCond,
		systemCond,
		and(eq(pages.category, "private"), eq(pages.createdBy, viewerId)),
	);
}

/**
 * viewerが閲覧できるページ名のSetを返す（pageExists判定用）。
 * 他人のprivateは含めない、自分のprivateは含める。
 * リクエスト単位で1回だけ呼び出して共有することを想定。
 */
export async function getExistingPageSet(
	db: D1Database,
	viewerId: number | null,
): Promise<Set<string>> {
	const d = drizzle(db);
	const rows = await d
		.select({ category: pages.category, unixName: pages.unixName })
		.from(pages)
		.where(visibleByViewer(viewerId));
	const set = new Set<string>();
	for (const p of rows) {
		set.add(formatPagePath(p.category, p.unixName));
		set.add(`${p.category}:${p.unixName}`);
	}
	return set;
}

/**
 * SHA-256 を hex で返す。html-block の content-addressed key に使用。
 */
async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return bytesToHex(new Uint8Array(hashBuffer));
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

/**
 * HMAC-SHA256 を hex で返す。private html-block の ukey 生成に使用。
 */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const keyData = new TextEncoder().encode(secret);
	const key = await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return bytesToHex(new Uint8Array(sig));
}

/**
 * private html-block 用の ukey 付き URL を生成する。
 * パスは share と同じ `/local--html/<page>/<hash>` で、ukey + exp の有無で
 * files-worker 側が public / private を分岐する（Wikidot互換）。
 * ukey = HMAC-SHA256(FILES_URL_SECRET, `${page}:${hash}:${exp}`)
 * exp は Unix秒（1時間後）
 */
async function buildPrivateHtmlBlockUrl(
	filesDomain: string,
	page: string,
	hash: string,
	secret: string,
): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + 3600;
	const ukey = await hmacSha256Hex(secret, `${page}:${hash}:${exp}`);
	return `${filesDomain}/local--html/${page}/${hash}?ukey=${ukey}&exp=${exp}`;
}

/**
 * pageExists callback に渡される page 文字列を、DB保存形式と整合する形に正規化する。
 * share/private のとき unix_name 部分は小文字統一されているため、入力も小文字化する。
 */
function normalizePageKey(page: string): string {
	const [category, unixName] = parsePagePath(page);
	if (isShare(category) || isPrivate(category)) {
		return `${category}:${normalizeUlid(unixName)}`;
	}
	return page;
}

/**
 * wikitextソースをパース・レンダリングしてHTMLを返す。
 * include展開、モジュール解決（ListPages, IfTags等）もサーバーサイドで行う。
 * viewerId に応じて他人のprivateは include / ListPages / pageExists 全てから除外。
 */
export async function renderWikitext(
	source: string,
	env: Bindings,
	options: {
		pageName: string;
		category: string;
		tags?: string[];
		viewerId?: number | null;
		existingPages?: Set<string>;
		// true のときだけ html-block を R2 に PUT する。
		// save 系 (POST /api/page/new, PUT /api/page/*) のみ true。
		// preview / GET / nav の read 系では false（URL 生成のみ）
		persistHtmlBlocks?: boolean;
	},
): Promise<RenderResult> {
	const db = drizzle(env.DB);
	const viewerId = options.viewerId ?? null;

	// include展開: 限定列挙で share/system のみ許可（private/未知カテゴリは一律 null）
	const expanded = await resolveIncludesAsync(source, async (pageRef) => {
		const [catRaw, nameRaw] = parsePagePath(pageRef.page);
		const cat = catRaw;
		const name = isShare(cat) || isPrivate(cat) ? normalizeUlid(nameRaw) : nameRaw;
		const vis = getVisibility(cat, name);
		if (vis !== "share" && vis !== "system") {
			return null;
		}
		const result = await db
			.select({ source: pages.source })
			.from(pages)
			.where(and(eq(pages.category, cat), eq(pages.unixName, name)))
			.limit(1);
		return result[0]?.source ?? null;
	});

	const parseResult = parse(expanded);
	const ast = parseResult.ast;

	const extraction = extractDataRequirements(ast);

	const dataProvider: DataProvider = {
		async fetchListPages(_query, _requirement) {
			const visiblePages = await db.select().from(pages).where(visibleByViewer(viewerId));
			const allTags = await db.select().from(pageTags);
			const tagsByPageId = new Map<number, string[]>();
			for (const t of allTags) {
				const existing = tagsByPageId.get(t.pageId) ?? [];
				existing.push(t.tag);
				tagsByPageId.set(t.pageId, existing);
			}

			return {
				pages: visiblePages.map((p) => ({
					name: p.unixName,
					category: p.category,
					fullname: formatPagePath(p.category, p.unixName),
					title: p.title,
					createdAt: new Date(p.createdAt ?? ""),
					updatedAt: new Date(p.updatedAt ?? ""),
					tags: tagsByPageId.get(p.id) ?? [],
					hiddenTags: [] as string[],
					rating: 0,
					ratingVotes: 0,
					revisions: p.revisionCount ?? 0,
					children: 0,
					comments: 0,
					size: (p.source ?? "").length,
				})),
				totalCount: visiblePages.length,
				site: { title: "WPv4", name: "wpv4", domain: "" },
			};
		},
		getPageTags: () => options.tags ?? [],
	};

	const resolveOptions: ResolveOptions = {
		parse: (src) => parse(src).ast,
		compiledListPagesTemplates: extraction.compiledListPagesTemplates,
		compiledListUsersTemplates: extraction.compiledListUsersTemplates,
		requirements: extraction.requirements,
	};

	const resolvedAst = await resolveModules(ast, dataProvider, resolveOptions);

	const existingPages = options.existingPages ?? (await getExistingPageSet(env.DB, viewerId));

	// html-block を R2 に content-addressed で保存し、iframe URL を返す resolver を構築
	// R2 key / URL パスは Wikidot 互換で `local--html/<page>/<hash>` 統一
	// - share / system: ukey なし（CDN cache 可、誰でも閲覧）
	// - private: ukey(HMAC) + exp 付き URL（files-worker が検証、非キャッシュ）
	const isPrivatePage = isPrivate(options.category);
	const htmlBlocks = resolvedAst["html-blocks"] ?? [];
	const filesDomain = env.FILES_DOMAIN.replace(/\/$/, "");

	// hash は常に計算（URL生成に必要）、R2 PUT は persistHtmlBlocks=true のときだけ
	const htmlBlockHashes = await Promise.all(
		htmlBlocks.map(async (content) => {
			const hash = await sha256Hex(content);
			if (options.persistHtmlBlocks) {
				await env.R2.put(`local--html/${options.pageName}/${hash}`, content, {
					httpMetadata: { contentType: "text/html; charset=utf-8" },
				});
			}
			return hash;
		}),
	);

	const htmlBlockUrls = await Promise.all(
		htmlBlockHashes.map(async (hash) => {
			if (!hash) return "";
			if (isPrivatePage) {
				return buildPrivateHtmlBlockUrl(filesDomain, options.pageName, hash, env.FILES_URL_SECRET);
			}
			return `${filesDomain}/local--html/${options.pageName}/${hash}`;
		}),
	);
	const htmlBlockUrl = (index: number): string => htmlBlockUrls[index] ?? "";

	const renderOptions: RenderOptions = {
		page: {
			pageName: options.pageName,
			site: "wpv4",
			tags: options.tags ?? [],
			pageExists: (name: string) => existingPages.has(normalizePageKey(name)),
		},
		resolvers: { htmlBlockUrl },
	};

	const html = renderToHtml(resolvedAst, renderOptions);

	const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
	const styles: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = styleRegex.exec(html)) !== null) {
		styles.push(match[1]);
	}
	const cleanHtml = html.replace(styleRegex, "");

	return { html: cleanHtml, styles };
}

/**
 * ページパス ("category:name" or "name") を [category, unix_name] に分解する。
 */
export function parsePagePath(path: string): [string, string] {
	const colonIndex = path.indexOf(":");
	if (colonIndex === -1) {
		return ["_default", path];
	}
	return [path.slice(0, colonIndex), path.slice(colonIndex + 1)];
}

/**
 * category + unix_name から表示用パスを生成する。
 * _default カテゴリはカテゴリ名を省略する。
 */
export function formatPagePath(category: string, unixName: string): string {
	if (category === "_default") {
		return unixName;
	}
	return `${category}:${unixName}`;
}
