import {
	parse,
	resolveIncludesAsync,
	extractDataRequirements,
	resolveModules,
} from "@wdprlib/parser";
import type { DataProvider, ResolveOptions, NormalizedListPagesQuery } from "@wdprlib/parser";
import { renderToHtml } from "@wdprlib/render";
import type { RenderOptions } from "@wdprlib/render";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, ne, inArray, notInArray, desc, asc, sql, type SQL } from "drizzle-orm";
import { pages, pageTags } from "@/db/schema";
import { canViewPage, isUlidCategory, normalizeUlid, visibilityPolicy } from "@/lib/visibility";
import type { Bindings } from "@/types/env";

export type RenderResult = {
	html: string;
	styles: string[];
};

/**
 * viewer視点で「閲覧可能」なページの WHERE 句（pageExists / include / fetch 用）。
 * private はそもそも include 不可・他人の private を pageExists で見せたくないため
 * owner例外なしで一律除外する（含めると include 仕様と意味が割れる）。
 */
function visibleByViewer(_viewerId: number | null) {
	return ne(pages.category, "private");
}

/**
 * ListPages モジュール用の WHERE 句: share / private を除いた public 相当のページのみ。
 * share は URL を知っている人だけが見る semi-public、private は作成者専用なので一覧非掲載。
 */
function listPagesScope() {
	return and(ne(pages.category, "share"), ne(pages.category, "private"));
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
 * 指定 page の html-block を visibility 切替に伴って R2 prefix 間で移動する。
 * old prefix から list → copy → delete を直列実行（少数想定なのでO(n)で十分）。
 * R2 list の prefix は `${prefix}/${page}/` で限定し、 他 page の object を巻き込まない。
 *
 * codex 2回目 Finding 2 対応: visibility toggle 時に旧 prefix のオブジェクトが
 * 残り続けると、URL 切替後に 404 が出る + 旧 prefix からの漏洩リスク（private→public 後の
 * 旧 local--html/ オブジェクトは無いので問題ないが、public→private で旧 local--html/ が
 * 残ると ukey 無しでアクセス可能）になるため、必ず移動する。
 */
export async function moveHtmlBlocksForVisibilityChange(
	r2: R2Bucket,
	page: string,
	fromVisibility: "public" | "share" | "private",
	toVisibility: "public" | "share" | "private",
): Promise<void> {
	const fromPrefix = fromVisibility === "private" ? "private--html" : "local--html";
	const toPrefix = toVisibility === "private" ? "private--html" : "local--html";
	if (fromPrefix === toPrefix) return;

	const list = await r2.list({ prefix: `${fromPrefix}/${page}/` });
	for (const obj of list.objects) {
		const newKey = obj.key.replace(`${fromPrefix}/`, `${toPrefix}/`);
		const src = await r2.get(obj.key);
		if (!src) continue;
		await r2.put(newKey, src.body, { httpMetadata: src.httpMetadata });
		await r2.delete(obj.key);
	}
}

/**
 * private html-block 用の ukey 付き URL を生成する。
 * R2 key と URL パスは public/share と分離して `/private--html/<page>/<hash>` を使う。
 * これにより URL から ?ukey=... を削っても public 経路で配信されない（security 優先で
 * Wikidot URL 互換は犠牲にする）。
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
	return `${filesDomain}/private--html/${page}/${hash}?ukey=${ukey}&exp=${exp}`;
}

/**
 * pageExists callback に渡される page 文字列を、DB保存形式と整合する形に正規化する。
 * share/private のとき unix_name 部分は小文字統一されているため、入力も小文字化する。
 */
function normalizePageKey(page: string): string {
	const [category, unixName] = parsePagePath(page);
	if (isUlidCategory(category)) {
		return `${category}:${normalizeUlid(unixName)}`;
	}
	return page;
}

// Wikidot ListPages の order 文字列を pages カラムにマップする。
// 未知の order はデフォルト（created_at DESC）にフォールバック。
const ORDER_COLUMN_MAP = {
	created_at: pages.createdAt,
	updated_at: pages.updatedAt,
	title: pages.title,
	fullname: pages.unixName,
} as const;

// 上限ガード（wdmock-cf 同等）。 SQL injection や DoS（大 OFFSET）を防ぐ目的。
const LIST_PAGES_LIMIT_CAP = 100;
const LIST_PAGES_OFFSET_CAP = 1000;
const LIST_PAGES_DEFAULT_LIMIT = 20;

type Db = ReturnType<typeof drizzle>;

/**
 * ListPages モジュール用のデータ取得。
 * Wikidot 互換の query パラメータを DB レベルで適用し、 limit/offset/order まで含めて
 * 完全な ListPagesExternalData を返す。
 *
 * セキュリティ要点:
 *  - range="." は options.pageName/category を信頼するが、 viewerId に対する canViewPage
 *    を最終フィルタとして必ず適用する。未認証 preview から他人の private ページ本文を
 *    読み出されることを防ぐため（codex review High）。
 *  - 明示的 category フィルタが無いときだけ listPagesScope（share/private 除外）を
 *    かける。明示指定があれば従い、その結果に対しても canViewPage を最終適用する。
 */
async function fetchListPagesData(
	db: Db,
	query: NormalizedListPagesQuery,
	ctx: {
		currentCategory: string;
		currentPageName: string;
		currentTags: string[];
		viewerId: number | null;
	},
) {
	const site = { title: "WPv4", name: "wpv4", domain: "" };

	// limit=0 は「URL 未指定」の合図イディオム（offset/limit="@URL|0"）。
	// wdmock-cf の queryListPages 同様、即空集合を返してモジュール本体を消す。
	if (query.limit === 0) {
		return { pages: [], totalCount: 0, site };
	}

	// WHERE 句構築
	const conditions: SQL[] = [];

	if (query.range === ".") {
		// 自分自身。 share/private 除外もここでは外す（自己参照のため）。
		// canViewPage 相当は最後の private/createdBy 条件で SQL レベルで担保する。
		conditions.push(
			and(eq(pages.category, ctx.currentCategory), eq(pages.unixName, ctx.currentPageName)) as SQL,
		);
	} else {
		// range="." 以外では share/private を ListPages から完全に除外（spec: 列挙不可）。
		// codex 指摘 High: category="share" や "*" 経由でも share ページを引けてはならない。
		// canViewPage だけでは share を防げないため、 SQL レベルで強制する。
		conditions.push(listPagesScope() as SQL);
	}

	if (query.category) {
		// "*" (all) は include filter なし（exclude のみ反映）。
		// "." (current) は現ページの category だけに絞る。
		// 通常の include 指定は IN で絞り、 exclude は all/current/include いずれの後でも
		// 必ず追加適用する（codex 指摘 Medium: all/current で exclude が無視される）。
		if (query.category.current) {
			conditions.push(eq(pages.category, ctx.currentCategory));
		} else if (!query.category.all && query.category.include.length > 0) {
			conditions.push(inArray(pages.category, query.category.include));
		}
		for (const cat of query.category.exclude) {
			conditions.push(ne(pages.category, cat));
		}
	}

	if (query.name) {
		conditions.push(eq(pages.unixName, query.name));
	}

	if (query.fullname) {
		const [fcat, fname] = parsePagePath(query.fullname);
		conditions.push(and(eq(pages.category, fcat), eq(pages.unixName, fname)) as SQL);
	}

	if (query.tags) {
		for (const tag of query.tags.all) {
			const sub = db
				.select({ pageId: pageTags.pageId })
				.from(pageTags)
				.where(eq(pageTags.tag, tag));
			conditions.push(inArray(pages.id, sub));
		}
		if (query.tags.any.length > 0) {
			const sub = db
				.select({ pageId: pageTags.pageId })
				.from(pageTags)
				.where(inArray(pageTags.tag, query.tags.any));
			conditions.push(inArray(pages.id, sub));
		}
		for (const tag of query.tags.none) {
			const sub = db
				.select({ pageId: pageTags.pageId })
				.from(pageTags)
				.where(eq(pageTags.tag, tag));
			conditions.push(notInArray(pages.id, sub));
		}
		// special:
		//  - "none"         → タグが一つも無い page
		//  - "same-visible" → 現ページの visible (非 _-prefix) タグを少なくとも 1 つ共有
		//  - "same-all"     → 現ページの全タグ（hidden 含む）を少なくとも 1 つ共有
		// codex 指摘 Medium: same-visible / same-all を未処理にすると tags="=" 系が
		// 何の条件にもならず想定外のページが出る。
		if (query.tags.special === "none") {
			const sub = db.selectDistinct({ pageId: pageTags.pageId }).from(pageTags);
			conditions.push(notInArray(pages.id, sub));
		} else if (query.tags.special === "same-visible" || query.tags.special === "same-all") {
			const sourceTags =
				query.tags.special === "same-all"
					? ctx.currentTags
					: ctx.currentTags.filter((t) => !t.startsWith("_"));
			if (sourceTags.length === 0) {
				return { pages: [], totalCount: 0, site };
			}
			const sub = db
				.select({ pageId: pageTags.pageId })
				.from(pageTags)
				.where(inArray(pageTags.tag, sourceTags));
			conditions.push(inArray(pages.id, sub));
		}
	}

	// canViewPage 相当を SQL に内包する（codex 指摘 Medium: COUNT/limit/offset の前で
	// 弾かないと %%total%% と pagination が壊れる）。
	// 仕様: private は createdBy === viewerId のみ可視。 viewerId=null なら一切不可。
	if (ctx.viewerId === null) {
		conditions.push(ne(pages.category, "private"));
	} else {
		conditions.push(sql`(${pages.category} != 'private' OR ${pages.createdBy} = ${ctx.viewerId})`);
	}

	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	// Order: 既知フィールドをマップ、それ以外（rating/votes/random 等は未対応）は
	// デフォルトの created_at DESC にフォールバック。
	const orderField =
		query.order && (ORDER_COLUMN_MAP as Record<string, unknown>)[query.order.field]
			? ORDER_COLUMN_MAP[query.order.field as keyof typeof ORDER_COLUMN_MAP]
			: pages.createdAt;
	const orderDir = query.order?.direction === "asc" ? asc : desc;

	// Limit / Offset（上限ガード）。 wdmock-cf と同等の挙動。
	const limit =
		query.limit !== undefined && query.limit > 0
			? Math.min(query.limit, LIST_PAGES_LIMIT_CAP)
			: LIST_PAGES_DEFAULT_LIMIT;
	const offset =
		query.offset !== undefined && query.offset > 0
			? Math.min(query.offset, LIST_PAGES_OFFSET_CAP)
			: 0;

	// totalCount は WHERE のみ適用（limit/offset 抜き）。
	const totalCountRow = await db
		.select({ count: sql<number>`COUNT(*)` })
		.from(pages)
		.where(whereClause);
	const totalCountRaw = Number(totalCountRow[0]?.count ?? 0);

	// 本体取得（limit/offset 適用）
	const rows = await db
		.select()
		.from(pages)
		.where(whereClause)
		.orderBy(orderDir(orderField))
		.limit(limit)
		.offset(offset);

	// canViewPage（最終ガード）。 range="." / 明示 category="private" 等での
	// 不正参照を、ここで一律弾く。
	const visibleRows = rows.filter((p) => canViewPage(p, ctx.viewerId));

	// 対象 page の tags のみ取得（全件読みを避ける）
	const visibleIds = visibleRows.map((p) => p.id);
	const tagRows =
		visibleIds.length > 0
			? await db.select().from(pageTags).where(inArray(pageTags.pageId, visibleIds))
			: [];
	const tagsByPageId = new Map<number, string[]>();
	for (const t of tagRows) {
		const existing = tagsByPageId.get(t.pageId) ?? [];
		existing.push(t.tag);
		tagsByPageId.set(t.pageId, existing);
	}

	return {
		pages: visibleRows.map((p) => ({
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
			// %%content%% / %%content{N}%% （==== 区切り）テンプレ変数用。
			content: p.source ?? "",
		})),
		// totalCount は WHERE のみ。 canViewPage で落ちた件数は反映していない
		// （wdmock-cf 互換、 ListPages の %%total%% も本質的に WHERE ベース）。
		totalCount: totalCountRaw,
		site,
	};
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
		// Wikidot 形式の URL パス（例: "/private:01ks.../offset/1/page2_limit/1"）。
		// @URL|default や urlAttrPrefix を含む ListPages のパラメータ解決に使う。
		// 未指定なら全 @URL は default 値で解決される。
		urlPath?: string;
	},
): Promise<RenderResult> {
	const db = drizzle(env.DB);
	const viewerId = options.viewerId ?? null;

	// include 展開:
	// - pages.unix_name は単独 UNIQUE なので、ULID/固定名どちらも一意特定可能
	// - public↔share トグルで category が変わっても unix_name 検索なら追従できる
	//   (codex 2回目 Finding 1: include は category 非依存で解決すべき)
	// - canInclude 判定は「DB 上の現在の category」で行う (URL での指定ではなく)
	const expanded = await resolveIncludesAsync(source, async (pageRef) => {
		const [catRaw, nameRaw] = parsePagePath(pageRef.page);
		const name = isUlidCategory(catRaw) ? normalizeUlid(nameRaw) : nameRaw;
		const result = await db
			.select({ source: pages.source, category: pages.category })
			.from(pages)
			.where(eq(pages.unixName, name))
			.limit(1);
		if (!result[0]) return null;
		if (!visibilityPolicy(result[0].category).canInclude) return null;
		return result[0].source;
	});

	// pageTags を parse() に渡し、[[div_ class="x" [[iftags +foo]]...[[/iftags]]]]
	// のような opener-embedded [[iftags]] を text-level に畳む。
	// options.tags が未指定なら null フォールバック (opener-embedded のみ空タグ
	// 仮定で畳む)、block-level は AST resolver に委譲される。
	const parserPageTags = options.tags ?? null;

	const parseResult = parse(expanded, { pageTags: parserPageTags });
	const ast = parseResult.ast;

	const extraction = extractDataRequirements(ast);

	const dataProvider: DataProvider = {
		async fetchListPages(query, _requirement) {
			return fetchListPagesData(db, query, {
				currentCategory: options.category,
				currentPageName: options.pageName,
				currentTags: options.tags ?? [],
				viewerId,
			});
		},
		getPageTags: () => options.tags ?? [],
	};

	const resolveOptions: ResolveOptions = {
		parse: (src) => parse(src, { pageTags: parserPageTags }).ast,
		compiledListPagesTemplates: extraction.compiledListPagesTemplates,
		compiledListUsersTemplates: extraction.compiledListUsersTemplates,
		requirements: extraction.requirements,
		// @URL|... と urlAttrPrefix の解決に必要。 未指定なら全部 default 値。
		urlPath: options.urlPath,
	};

	const resolvedAst = await resolveModules(ast, dataProvider, resolveOptions);

	const existingPages = options.existingPages ?? (await getExistingPageSet(env.DB, viewerId));

	// html-block を R2 に content-addressed で保存し、iframe URL を返す resolver を構築
	// R2 key と URL パスは visibility で分離（security 優先で URL 削っても漏洩しない）:
	// - public / share / その他: `local--html/<page>/<hash>` (ukey なし、CDN cache 可)
	// - private:                 `private--html/<page>/<hash>?ukey=...&exp=...` (HMAC 必須)
	const pagePolicy = visibilityPolicy(options.category);
	const isPrivatePage = pagePolicy.visibility === "private";
	const r2Prefix = isPrivatePage ? "private--html" : "local--html";
	const htmlBlocks = resolvedAst["html-blocks"] ?? [];
	const filesDomain = env.FILES_DOMAIN.replace(/\/$/, "");

	// hash は常に計算（URL生成に必要）、R2 PUT は persistHtmlBlocks=true のときだけ
	const htmlBlockHashes = await Promise.all(
		htmlBlocks.map(async (content) => {
			const hash = await sha256Hex(content);
			if (options.persistHtmlBlocks) {
				await env.R2.put(`${r2Prefix}/${options.pageName}/${hash}`, content, {
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
 * Wikidot 形式の URL パラメータ ("name/offset/1/page2_limit/1" など) は
 * ページ識別子の後ろに付くため、最初の "/" セグメントだけをページ部分として扱う。
 */
export function parsePagePath(path: string): [string, string] {
	const cleaned = path.replace(/^\/+|\/+$/g, "");
	const pageSegment = cleaned.split("/")[0] ?? "";
	const colonIndex = pageSegment.indexOf(":");
	if (colonIndex === -1) {
		return ["_default", pageSegment];
	}
	return [pageSegment.slice(0, colonIndex), pageSegment.slice(colonIndex + 1)];
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
