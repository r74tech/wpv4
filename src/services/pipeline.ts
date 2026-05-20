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
import { eq, and } from "drizzle-orm";
import { pages, pageTags } from "@/db/schema";
import type { Bindings } from "@/types/env";

export type RenderResult = {
	html: string;
	styles: string[];
};

/**
 * DBから全ページ名のSetを取得する。リクエスト単位で1回だけ呼び出して共有する。
 */
export async function getExistingPageSet(db: D1Database): Promise<Set<string>> {
	const d = drizzle(db);
	const rows = await d.select({ category: pages.category, unixName: pages.unixName }).from(pages);
	const set = new Set<string>();
	for (const p of rows) {
		set.add(formatPagePath(p.category, p.unixName));
		set.add(`${p.category}:${p.unixName}`);
	}
	return set;
}

/**
 * wikitextソースをパース・レンダリングしてHTMLを返す。
 * include展開、モジュール解決（ListPages, IfTags等）もサーバーサイドで行う。
 */
export async function renderWikitext(
	source: string,
	env: Bindings,
	options: {
		pageName: string;
		category: string;
		tags?: string[];
		existingPages?: Set<string>;
	},
): Promise<RenderResult> {
	const db = drizzle(env.DB);

	// include展開: resolveIncludesAsync で非同期fetcherを直接使用
	const expanded = await resolveIncludesAsync(source, async (pageRef) => {
		const [cat, name] = parsePagePath(pageRef.page);
		const result = await db
			.select({ source: pages.source })
			.from(pages)
			.where(and(eq(pages.category, cat), eq(pages.unixName, name)))
			.limit(1);
		return result[0]?.source ?? null;
	});

	// パース
	const parseResult = parse(expanded);
	const ast = parseResult.ast;

	// モジュール解決
	const extraction = extractDataRequirements(ast);

	const dataProvider: DataProvider = {
		async fetchListPages(_query, _requirement) {
			const allPages = await db.select().from(pages);
			const allTags = await db.select().from(pageTags);
			const tagsByPageId = new Map<number, string[]>();
			for (const t of allTags) {
				const existing = tagsByPageId.get(t.pageId) ?? [];
				existing.push(t.tag);
				tagsByPageId.set(t.pageId, existing);
			}

			return {
				pages: allPages.map((p) => ({
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
				totalCount: allPages.length,
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

	// ページ存在確認用のSet
	const existingPages = options.existingPages ?? (await getExistingPageSet(env.DB));

	// HTML生成
	const renderOptions: RenderOptions = {
		page: {
			pageName: options.pageName,
			site: "wpv4",
			tags: options.tags ?? [],
			pageExists: (name: string) => existingPages.has(name),
		},
	};

	const html = renderToHtml(resolvedAst, renderOptions);

	// スタイル抽出
	const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
	const styles: string[] = [];
	let cleanHtml = html;
	let match: RegExpExecArray | null;

	while ((match = styleRegex.exec(html)) !== null) {
		styles.push(match[1]);
	}
	cleanHtml = html.replace(styleRegex, "");

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
