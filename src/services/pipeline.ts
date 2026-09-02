import { createSettings, processWikitext } from "@wdprlib/parser";
import type {
	NormalizedListPagesQuery,
	TagCloudDataRequirement,
	TagCloudExternalData,
} from "@wdprlib/parser";
import { renderWikitext as renderProcessedWikitext } from "@wdprlib/render";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, ne, inArray, notInArray, desc, asc, sql, isNull, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { pages, pageTags, users } from "@/db/schema";
import { canViewPage, isUlidCategory, normalizeUlid, visibilityPolicy } from "@/lib/visibility";
import { resolveLocalIncludeUnixName } from "@/lib/include-reference";
import { userAvatarUrl, userProfileUrl } from "@/lib/user-markup";
import { normalizeWikidotCategoryName } from "@/lib/wikidot-name";
import type { Bindings } from "@/types/env";

export type RenderResult = {
	html: string;
	styles: string[];
};

const AVATAR_USER_LOOKUP_LIMIT = 100;

/**
 * viewer視点で「閲覧可能」なページの WHERE 句（pageExists / include / fetch 用）。
 * private はそもそも include 不可・他人の private を pageExists で見せたくないため
 * owner例外なしで一律除外する（含めると include 仕様と意味が割れる）。
 */
function visibleByViewer(_viewerId: number | null) {
	return and(ne(pages.category, "private"), isNull(pages.deletedAt));
}

/**
 * ListPages モジュール用の WHERE 句: share / private を除いた public 相当のページのみ。
 * share は URL を知っている人だけが見る semi-public、private は作成者専用なので一覧非掲載。
 */
function listPagesScope() {
	return and(ne(pages.category, "share"), ne(pages.category, "private"), isNull(pages.deletedAt));
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
 * visibility toggle 時に旧 prefix のオブジェクトが
 * 残り続けると、URL 切替後に 404 が出る + 旧 prefix からの漏洩リスク（private→public 後の
 * 旧 local--html/ オブジェクトは無いので問題ないが、public→private で旧 local--html/ が
 * 残ると ukey 無しでアクセス可能）になるため、必ず移動する。
 */
export async function moveHtmlBlocksForVisibilityChange(
	r2: R2Bucket,
	page: string,
	fromVisibility: "public" | "share" | "private",
	toVisibility: "public" | "share" | "private",
): Promise<string[]> {
	const fromPrefix = fromVisibility === "private" ? "private--html" : "local--html";
	const toPrefix = toVisibility === "private" ? "private--html" : "local--html";
	if (fromPrefix === toPrefix) return [];

	const moved: string[] = [];
	let cursor: string | undefined;
	try {
		do {
			const list = await r2.list({ prefix: `${fromPrefix}/${page}/`, cursor });
			for (const obj of list.objects) {
				const newKey = obj.key.replace(`${fromPrefix}/`, `${toPrefix}/`);
				const src = await r2.get(obj.key);
				if (!src) continue;
				await r2.put(newKey, src.body, { httpMetadata: src.httpMetadata });
				await r2.delete(obj.key);
				moved.push(newKey);
			}
			cursor = list.truncated ? list.cursor : undefined;
		} while (cursor);
	} catch (error) {
		await restoreMovedHtmlBlocks(r2, moved, fromVisibility, toVisibility);
		throw error;
	}
	return moved;
}

export async function restoreMovedHtmlBlocks(
	r2: R2Bucket,
	destinationKeys: readonly string[],
	fromVisibility: "public" | "share" | "private",
	toVisibility: "public" | "share" | "private",
): Promise<void> {
	const fromPrefix = fromVisibility === "private" ? "private--html" : "local--html";
	const toPrefix = toVisibility === "private" ? "private--html" : "local--html";
	for (const destinationKey of destinationKeys) {
		const source = await r2.get(destinationKey);
		if (!source) continue;
		const restoredKey = destinationKey.replace(`${toPrefix}/`, `${fromPrefix}/`);
		await r2.put(restoredKey, source.body, { httpMetadata: source.httpMetadata });
		await r2.delete(destinationKey);
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

const D1_PAGE_EXISTENCE_BATCH_SIZE = 90;

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
const HIDDEN_TAG_PREFIX = "_";

type Db = ReturnType<typeof drizzle>;

function normalizePageLinkTarget(page: string): string {
	let normalized = page.toLowerCase();
	if (normalized.includes(":")) normalized = normalized.replace(/:\s+/g, ":");
	if (/\s/.test(normalized)) normalized = normalized.replace(/\s+/g, "-").trim();
	if (!normalized.startsWith("/") && normalized.includes("/")) {
		normalized = normalized.replace(/\//g, "-");
	}
	return normalized.startsWith("/") ? normalized.slice(1) : normalized;
}

function normalizePageLookup(page: string): {
	canonical: string;
	unixName: string;
} {
	const [category, rawUnixName] = parsePagePath(normalizePageLinkTarget(page));
	const unixName = isUlidCategory(category) ? normalizeUlid(rawUnixName) : rawUnixName;
	return { canonical: formatPagePath(category, unixName), unixName };
}

async function findExistingPages(
	db: Db,
	requestedPages: string[],
	viewerId: number | null,
): Promise<ReadonlySet<string>> {
	if (requestedPages.length === 0) return new Set();

	const requestedByCanonical = new Map<string, string[]>();
	const unixNames = new Set<string>();
	for (const requested of requestedPages) {
		const { canonical, unixName } = normalizePageLookup(requested);
		requestedByCanonical.set(canonical, [
			...(requestedByCanonical.get(canonical) ?? []),
			requested,
		]);
		unixNames.add(unixName);
	}

	const batches: string[][] = [];
	const allUnixNames = [...unixNames];
	for (let index = 0; index < allUnixNames.length; index += D1_PAGE_EXISTENCE_BATCH_SIZE) {
		batches.push(allUnixNames.slice(index, index + D1_PAGE_EXISTENCE_BATCH_SIZE));
	}

	const results = await Promise.all(
		batches.map((batch) =>
			db
				.select({ category: pages.category, unixName: pages.unixName })
				.from(pages)
				.where(and(visibleByViewer(viewerId), inArray(pages.unixName, batch))),
		),
	);

	const existing = new Set<string>();
	for (const rows of results) {
		for (const row of rows) {
			const canonical = formatPagePath(row.category, row.unixName);
			for (const requested of requestedByCanonical.get(canonical) ?? []) existing.add(requested);
		}
	}
	return existing;
}

/**
 * ListPages モジュール用のデータ取得。
 * Wikidot 互換の query パラメータを DB レベルで適用し、 limit/offset/order まで含めて
 * 完全な ListPagesExternalData を返す。
 *
 * セキュリティ要点:
 *  - range="." は options.pageName/category を信頼するが、 viewerId に対する canViewPage
 *    を最終フィルタとして必ず適用する。未認証 preview から他人の private ページ本文を
 *    読み出されることを防ぐため。
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
	const conditions: SQL[] = [isNull(pages.deletedAt)];

	if (query.range === ".") {
		// 自分自身。 share/private 除外もここでは外す（自己参照のため）。
		// canViewPage 相当は最後の private/createdBy 条件で SQL レベルで担保する。
		conditions.push(
			and(eq(pages.category, ctx.currentCategory), eq(pages.unixName, ctx.currentPageName)) as SQL,
		);
	} else {
		// range="." 以外では share/private を ListPages から完全に除外（spec: 列挙不可）。
		// category="share" や "*" 経由でも share ページを引けてはならない。
		// canViewPage だけでは share を防げないため、 SQL レベルで強制する。
		conditions.push(listPagesScope() as SQL);
	}

	if (query.category) {
		// "*" (all) は include filter なし（exclude のみ反映）。
		// "." (current) は現ページの category だけに絞る。
		// 通常の include 指定は IN で絞り、 exclude は all/current/include いずれの後でも
		// 必ず追加適用し、all/current でも exclude を無視しない。
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

	if (query.createdBy) {
		if (query.createdBy === "=" || query.createdBy === "-=") {
			const currentAuthor = db
				.select({ id: pages.createdBy })
				.from(pages)
				.where(
					and(
						eq(pages.category, ctx.currentCategory),
						eq(pages.unixName, ctx.currentPageName),
						isNull(pages.deletedAt),
					),
				)
				.limit(1);
			conditions.push(
				query.createdBy === "="
					? sql`${pages.createdBy} IS (${currentAuthor})`
					: sql`${pages.createdBy} IS NOT (${currentAuthor})`,
			);
		} else {
			const matchingUsers = db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.unixName, query.createdBy));
			conditions.push(inArray(pages.createdBy, matchingUsers));
		}
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
		// same-visible / same-all を未処理にすると tags="=" 系が
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

	// canViewPage 相当を SQL に内包する（COUNT/limit/offset の前で
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
	const creator = alias(users, "creator");
	const updater = alias(users, "updater");
	const rows = await db
		.select({
			page: pages,
			creator: {
				id: creator.wikidotId,
				name: creator.name,
				unixName: creator.unixName,
			},
			updater: {
				id: updater.wikidotId,
				name: updater.name,
				unixName: updater.unixName,
			},
		})
		.from(pages)
		.leftJoin(creator, eq(pages.createdBy, creator.id))
		.leftJoin(updater, eq(pages.updatedBy, updater.id))
		.where(whereClause)
		.orderBy(orderDir(orderField))
		.limit(limit)
		.offset(offset);

	// canViewPage（最終ガード）。 range="." / 明示 category="private" 等での
	// 不正参照を、ここで一律弾く。
	const visibleRows = rows.filter(({ page }) => canViewPage(page, ctx.viewerId));

	// 対象 page の tags のみ取得（全件読みを避ける）
	const visibleIds = visibleRows.map(({ page }) => page.id);
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
		pages: visibleRows.map(({ page: p, creator, updater }) => ({
			name: p.unixName,
			category: p.category,
			fullname: formatPagePath(p.category, p.unixName),
			title: p.title,
			createdAt: new Date(p.createdAt ?? ""),
			createdBy: creator ?? undefined,
			updatedAt: new Date(p.updatedAt ?? ""),
			updatedBy: updater ?? undefined,
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

async function fetchTagCloudData(
	db: Db,
	requirement: TagCloudDataRequirement,
): Promise<TagCloudExternalData> {
	let category: string | null = null;

	if (requirement.category !== null) {
		category = normalizeWikidotCategoryName(requirement.category);
		if (category === "") {
			return { status: "category-not-found", category: requirement.category };
		}

		const categoryRows = await db
			.select({ category: pages.category })
			.from(pages)
			.where(and(listPagesScope(), eq(pages.category, category)))
			.limit(1);
		if (!categoryRows[0]) {
			return { status: "category-not-found", category: requirement.category };
		}
	}

	const weight = sql<number>`COUNT(${pageTags.pageId})`;
	const conditions: SQL[] = [
		listPagesScope() as SQL,
		sql`substr(${pageTags.tag}, 1, 1) != ${HIDDEN_TAG_PREFIX}`,
	];
	if (category !== null) conditions.push(eq(pages.category, category));

	const rows = await db
		.select({ tag: pageTags.tag, weight })
		.from(pageTags)
		.innerJoin(pages, eq(pageTags.pageId, pages.id))
		.where(and(...conditions))
		.groupBy(pageTags.tag)
		.orderBy(desc(weight), asc(pageTags.tag))
		.limit(requirement.limit);

	return {
		status: "ok",
		tags: rows.map((row) => ({ tag: row.tag, weight: Number(row.weight) })),
		category,
	};
}

/**
 * wikitextソースをパース・レンダリングしてHTMLを返す。
 * include展開、モジュール解決（ListPages, TagCloud, IfTags等）もサーバーサイドで行う。
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
		// 保存済みsourceを扱う呼び出し元だけtrueにする。
		// previewなど未保存sourceのrenderはfalseのままにしてR2へ公開しない。
		persistHtmlBlocks?: boolean;
		// Wikidot 形式の URL パス（例: "/private:01ks.../offset/1/page2_limit/1"）。
		// @URL|default や urlAttrPrefix を含む ListPages のパラメータ解決に使う。
		// 未指定なら全 @URL は default 値で解決される。
		urlPath?: string;
	},
): Promise<RenderResult> {
	const db = drizzle(env.DB);
	const viewerId = options.viewerId ?? null;
	const page = {
		fullName: formatPagePath(options.category, options.pageName),
		unixName: options.pageName,
		tags: options.tags ?? [],
		urlPath: options.urlPath,
		site: "wpv4",
		category: options.category,
		viewerId,
	};
	let listUsersLookup:
		| Promise<{ user: { number: number; title: string; name: string } } | null>
		| undefined;

	const document = await processWikitext(source, {
		page,
		settings: { ...createSettings("page"), allowStyleElements: true },
		dataProvider: {
			fetchInclude: async (pageRef) => {
				const unixName = resolveLocalIncludeUnixName(pageRef);
				if (unixName === null) return null;
				const result = await db
					.select({ source: pages.source, category: pages.category })
					.from(pages)
					.where(and(eq(pages.unixName, unixName), isNull(pages.deletedAt)))
					.limit(1);
				if (!result[0] || !visibilityPolicy(result[0].category).canInclude) return null;
				return result[0].source;
			},
			fetchListPages: (query) =>
				fetchListPagesData(db, query, {
					currentCategory: page.category,
					currentPageName: page.unixName,
					currentTags: page.tags,
					viewerId: page.viewerId,
				}),
			fetchListUsers: async () => {
				if (viewerId === null) return null;
				return (listUsersLookup ??= (async () => {
					const [user] = await db
						.select({
							number: users.wikidotId,
							title: users.name,
							name: users.unixName,
						})
						.from(users)
						.where(eq(users.id, viewerId))
						.limit(1);
					return user ? { user } : null;
				})());
			},
			fetchTagCloud: (requirement) => fetchTagCloudData(db, requirement),
		},
	});
	const pagePolicy = visibilityPolicy(options.category);
	const isPrivatePage = pagePolicy.visibility === "private";
	const r2Prefix = isPrivatePage ? "private--html" : "local--html";
	const filesDomain = env.FILES_DOMAIN.replace(/\/$/, "");
	const htmlBlockPersistence = new Map<string, Promise<void>>();
	const newlyPersistedHtmlBlockKeys = new Set<string>();
	const persistHtmlBlock = (key: string, content: string): Promise<void> => {
		const pending = htmlBlockPersistence.get(key);
		if (pending) return pending;

		const persistence = (async () => {
			if (await env.R2.head(key)) return;
			const stored = await env.R2.put(key, content, {
				onlyIf: { etagDoesNotMatch: "*" },
				httpMetadata: { contentType: "text/html; charset=utf-8" },
			});
			if (stored !== null) newlyPersistedHtmlBlockKeys.add(key);
		})();
		htmlBlockPersistence.set(key, persistence);
		return persistence;
	};
	const rendered = await renderProcessedWikitext(document, {
		styleMode: "separate",
		resolvers: {
			resolveUsers: async (usernames) => {
				const lookupNames = new Set<string>();
				for (const username of usernames) {
					if (lookupNames.size >= AVATAR_USER_LOOKUP_LIMIT) break;
					lookupNames.add(username.trim().toLowerCase().toWellFormed());
				}
				const avatarRows = await db
					.select({ unixName: users.avatarUnixName, wikidotId: users.wikidotId })
					.from(users)
					.where(inArray(users.avatarUnixName, [...lookupNames]));
				const avatarIds = new Map<string, number | null>();
				for (const row of avatarRows) {
					if (!row.unixName) continue;
					const normalized = row.unixName.trim().toLowerCase().toWellFormed();
					avatarIds.set(normalized, avatarIds.has(normalized) ? null : row.wikidotId);
				}

				return new Map(
					usernames.map((username) => {
						const normalized = username.trim().toLowerCase().toWellFormed();
						return [
							username,
							{
								url: userProfileUrl(normalized),
								avatarUrl: userAvatarUrl(filesDomain, avatarIds.get(normalized) ?? null),
							},
						] as const;
					}),
				);
			},
			resolvePageExistence: (requestedPages) => findExistingPages(db, requestedPages, viewerId),
			resolveHtmlBlockUrl: async ({ content }) => {
				const hash = await sha256Hex(content);
				const key = `${r2Prefix}/${options.pageName}/${hash}`;
				if (options.persistHtmlBlocks) {
					await persistHtmlBlock(key, content);
				}
				if (isPrivatePage) {
					return buildPrivateHtmlBlockUrl(
						filesDomain,
						options.pageName,
						hash,
						env.FILES_URL_SECRET,
					);
				}
				return `${filesDomain}/${key}`;
			},
		},
	});
	if (newlyPersistedHtmlBlockKeys.size > 0) {
		const currentPage = await db
			.select({ category: pages.category })
			.from(pages)
			.where(and(eq(pages.unixName, options.pageName), isNull(pages.deletedAt)))
			.limit(1);
		const currentIsPrivate = currentPage[0]
			? visibilityPolicy(currentPage[0].category).visibility === "private"
			: null;
		if (currentIsPrivate !== isPrivatePage) {
			await env.R2.delete([...newlyPersistedHtmlBlockKeys]);
		}
	}

	return { html: rendered.html, styles: rendered.styles };
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
