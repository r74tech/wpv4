import {
	parse,
	resolveIncludes,
	extractDataRequirements,
	resolveModules,
} from "@wdprlib/parser";
import type { DataProvider, ResolveOptions } from "@wdprlib/parser";
import { renderToHtml } from "@wdprlib/render";
import type { RenderOptions } from "@wdprlib/render";
import { drizzle } from "drizzle-orm/d1";
import { pages, pageTags } from "@/db/schema";
import type { Bindings } from "@/types/env";

export type RenderResult = {
	html: string;
	styles: string[];
};

// WDPRと同じinclude正規表現でページ参照を抽出する
const INCLUDE_PATTERN = /^\[\[include\s([^\]]*(?:\](?!\])[^\]]*)*)\]\]/gim;

/**
 * ソーステキストから[[include]]で参照されているページ名を抽出する。
 * WDPRのresolveIncludesと同じパターンを使用。
 */
function extractIncludeRefs(source: string): string[] {
	const refs: string[] = [];
	let match: RegExpExecArray | null;
	const regex = new RegExp(INCLUDE_PATTERN.source, INCLUDE_PATTERN.flags);
	while ((match = regex.exec(source)) !== null) {
		const inner = match[1].replace(/\n/g, " ");
		const parts = inner.split("|");
		const firstSegment = parts[0].trim();
		const spaceIndex = firstSegment.indexOf(" ");
		const target = spaceIndex !== -1 ? firstSegment.slice(0, spaceIndex) : firstSegment;
		// cross-site参照のsite部分を除去
		const page = target.startsWith(":") ? target.slice(target.indexOf(":", 1) + 1) : target;
		if (page) refs.push(page.toLowerCase());
	}
	return refs;
}

/**
 * includeで到達可能なページソースだけをDBから非同期収集する。
 * 再帰的にinclude先のinclude先も辿る（maxDepth: 5）。
 */
async function collectIncludeSources(
	db: ReturnType<typeof drizzle>,
	source: string,
	maxDepth = 5,
): Promise<Map<string, string>> {
	const collected = new Map<string, string>();
	const visited = new Set<string>();

	async function collect(src: string, depth: number) {
		if (depth >= maxDepth) return;

		const refs = extractIncludeRefs(src);
		const toFetch = refs.filter((r) => !visited.has(r));
		if (toFetch.length === 0) return;

		for (const ref of toFetch) visited.add(ref);

		// category:name形式とname単体の両方に対応
		const rows = await db
			.select({ category: pages.category, unixName: pages.unixName, source: pages.source })
			.from(pages);

		// refに一致するページを探す
		for (const row of rows) {
			const fullname = `${row.category}:${row.unixName}`;
			const matchesAny = toFetch.some(
				(ref) => ref === fullname || ref === row.unixName,
			);
			if (matchesAny && !collected.has(row.unixName)) {
				collected.set(fullname, row.source);
				collected.set(row.unixName, row.source);
				// 再帰: このページのinclude先も収集
				await collect(row.source, depth + 1);
			}
		}
	}

	await collect(source, 0);
	return collected;
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
	},
): Promise<RenderResult> {
	const db = drizzle(env.DB);

	// include展開: 到達可能なページだけを事前収集
	const pageSourceMap = await collectIncludeSources(db, source);

	const expanded = resolveIncludes(source, (pageRef) => {
		return pageSourceMap.get(pageRef.page) ?? null;
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
					fullname: `${p.category}:${p.unixName}`,
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

	// HTML生成
	const renderOptions: RenderOptions = {
		page: {
			pageName: options.pageName,
			site: "wpv4",
			tags: options.tags ?? [],
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
