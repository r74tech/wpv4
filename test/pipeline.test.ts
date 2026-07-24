import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { renderWikitext } from "../src/services/pipeline";
import type { Bindings } from "../src/types/env";

type BoundStatement = {
	raw(): Promise<unknown[][]>;
	all(): Promise<{ results: Record<string, unknown>[] }>;
};

type QueryExecution = {
	sql: string;
	params: unknown[];
};

type R2PutCall = {
	key: string;
	value: unknown;
	options: R2PutOptions;
};

type R2State = {
	keys: Set<string>;
	headCalls: string[];
	putCalls: R2PutCall[];
	successfulWrites: number;
};

function createD1Adapter(sqlite: Database, executions: QueryExecution[]): D1Database {
	return {
		prepare(query: string) {
			return {
				bind(...params: unknown[]): BoundStatement {
					executions.push({ sql: query, params });
					const statement = sqlite.query(query);
					return {
						raw: async () => statement.values(...params),
						all: async () => ({ results: statement.all(...params) }),
					};
				},
			};
		},
	} as unknown as D1Database;
}

function createDatabase(): Database {
	const sqlite = new Database(":memory:");
	sqlite.run(`
		CREATE TABLE pages (
			id INTEGER PRIMARY KEY,
			category TEXT NOT NULL,
			unix_name TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '',
			revision_count INTEGER DEFAULT 0,
			is_locked INTEGER NOT NULL DEFAULT 0,
			created_by INTEGER,
			updated_by INTEGER,
			created_at TEXT DEFAULT '2026-07-24T00:00:00.000Z',
			updated_at TEXT DEFAULT '2026-07-24T00:00:00.000Z'
		);
		CREATE TABLE page_tags (
			id INTEGER PRIMARY KEY,
			page_id INTEGER NOT NULL,
			tag TEXT NOT NULL
		);
	`);
	return sqlite;
}

function createR2State(): R2State {
	return { keys: new Set(), headCalls: [], putCalls: [], successfulWrites: 0 };
}

function createR2Recorder(state: R2State): R2Bucket {
	return {
		async head(key: string) {
			state.headCalls.push(key);
			return state.keys.has(key) ? ({ key } as R2Object) : null;
		},
		async put(key: string, value: unknown, options: R2PutOptions) {
			state.putCalls.push({ key, value, options });
			if (options.onlyIf instanceof Headers) throw new Error("Expected object R2 condition");
			if (options.onlyIf?.etagDoesNotMatch === "*" && state.keys.has(key)) return null;
			state.keys.add(key);
			state.successfulWrites++;
			return { key } as R2Object;
		},
	} as unknown as R2Bucket;
}

function createEnv(
	sqlite: Database,
	options: { executions?: QueryExecution[]; r2State?: R2State } = {},
): Bindings {
	return {
		DB: createD1Adapter(sqlite, options.executions ?? []),
		R2: createR2Recorder(options.r2State ?? createR2State()),
		OAUTH_PROVIDER_URL: "",
		CLIENT_ID: "",
		CLIENT_SECRET: "",
		SESSION_SECRET: "",
		FILES_DOMAIN: "https://files.example.com/",
		FILES_URL_SECRET: "test-secret",
	};
}

async function inspectLinks(html: string): Promise<Array<{ href: string; className: string }>> {
	const links: Array<{ href: string; className: string }> = [];
	const response = new HTMLRewriter()
		.on("a", {
			element(element) {
				links.push({
					href: element.getAttribute("href") ?? "",
					className: element.getAttribute("class") ?? "",
				});
			},
		})
		.transform(new Response(html));
	await response.text();
	return links;
}

function pageExistenceQueries(executions: QueryExecution[]): QueryExecution[] {
	return executions.filter(({ sql }) => {
		const normalized = sql.toLowerCase();
		return normalized.includes('from "pages"') && normalized.includes(" in (");
	});
}

const databases: Database[] = [];

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

describe("renderWikitext pipeline adapter", () => {
	test("bulk-resolves only requested visible pages with canonical DB lookup", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];
		const publicUlid = "01arz3ndektsv4rrffq69g5fav";
		const privateUlid = "01arz3ndektsv4rrffq69g5faw";
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name) VALUES
				(1, '_default', 'home'),
				(2, 'docs', 'guide'),
				(3, 'public', '${publicUlid}'),
				(4, 'private', '${privateUlid}'),
				(5, '_default', 'unrelated');
		`);

		const result = await renderWikitext(
			[
				"[[[home]]]",
				"[[[docs:guide]]]",
				`[[[public:${publicUlid.toUpperCase()}]]]`,
				`[[[private:${privateUlid}]]]`,
				"[[[missing]]]",
			].join("\n"),
			createEnv(sqlite, { executions }),
			{ pageName: "start", category: "_default" },
		);

		const links = await inspectLinks(result.html);
		expect(links).toHaveLength(5);
		expect(
			links.slice(0, 3).every((link) => !link.className.split(/\s+/).includes("newpage")),
		).toBe(true);
		expect(links.slice(3).every((link) => link.className.split(/\s+/).includes("newpage"))).toBe(
			true,
		);

		const existenceQueries = pageExistenceQueries(executions);
		expect(existenceQueries).toHaveLength(1);
		expect(existenceQueries[0]!.params).toContain("home");
		expect(existenceQueries[0]!.params).toContain("guide");
		expect(existenceQueries[0]!.params).toContain(publicUlid);
		expect(existenceQueries[0]!.params).toContain(privateUlid);
		expect(existenceQueries[0]!.params).toContain("missing");
		expect(existenceQueries[0]!.params).not.toContain("unrelated");
	});

	test("splits page-existence lookups at the 90-target boundary", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];
		const targets = Array.from({ length: 91 }, (_, index) => `missing-${index}`);

		await renderWikitext(
			targets.map((target) => `[[[${target}]]]`).join("\n"),
			createEnv(sqlite, { executions }),
			{ pageName: "start", category: "_default" },
		);

		const queryTargetCounts = pageExistenceQueries(executions).map(
			({ params }) => params.filter((value) => value !== "private").length,
		);
		expect(queryTargetCounts).toEqual([90, 1]);
	});

	test("uses the category-qualified page context and separates styles", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];

		const result = await renderWikitext(
			[
				"[[image attachment.png]]",
				"[[module CSS]]",
				".pipeline { color: red; }",
				"[[/module]]",
			].join("\n"),
			createEnv(sqlite, { executions }),
			{ pageName: "guide", category: "docs" },
		);

		expect(result.html).toContain("/local--files/docs:guide/attachment.png");
		expect(result.html).not.toContain("<style");
		expect(result.styles).toEqual([".pipeline { color: red; }"]);
		expect(pageExistenceQueries(executions)).toEqual([]);
	});

	test("preserves public and private html-block storage and URL behavior", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const publicState = createR2State();
		const privateState = createR2State();
		const previewState = createR2State();
		const source = "[[html]]<p>pipeline</p>[[/html]]";

		const preview = await renderWikitext(source, createEnv(sqlite, { r2State: previewState }), {
			pageName: "preview-page",
			category: "public",
		});
		const publicEnv = createEnv(sqlite, { r2State: publicState });
		const publicResult = await renderWikitext(source, publicEnv, {
			pageName: "public-page",
			category: "public",
			persistHtmlBlocks: true,
		});
		await renderWikitext(source, publicEnv, {
			pageName: "public-page",
			category: "public",
			persistHtmlBlocks: true,
		});
		const privateResult = await renderWikitext(
			source,
			createEnv(sqlite, { r2State: privateState }),
			{
				pageName: "private-page",
				category: "private",
				persistHtmlBlocks: true,
			},
		);

		expect(previewState.headCalls).toEqual([]);
		expect(previewState.putCalls).toEqual([]);
		expect(preview.html).toMatch(
			/src="https:\/\/files\.example\.com\/local--html\/preview-page\/[a-f0-9]{64}"/,
		);
		expect(publicState.headCalls).toHaveLength(2);
		expect(publicState.putCalls).toHaveLength(1);
		expect(publicState.successfulWrites).toBe(1);
		expect(publicState.putCalls[0]!.key).toMatch(/^local--html\/public-page\/[a-f0-9]{64}$/);
		expect(publicState.putCalls[0]!.value).toBe("<p>pipeline</p>");
		expect(publicState.putCalls[0]!.options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
		expect(publicResult.html).toContain(
			`src="https://files.example.com/${publicState.putCalls[0]!.key}"`,
		);

		expect(privateState.putCalls).toHaveLength(1);
		expect(privateState.putCalls[0]!.key).toMatch(/^private--html\/private-page\/[a-f0-9]{64}$/);
		expect(privateState.putCalls[0]!.value).toBe("<p>pipeline</p>");
		expect(privateResult.html).toMatch(
			/src="https:\/\/files\.example\.com\/private--html\/private-page\/[a-f0-9]{64}\?ukey=[a-f0-9]{64}&amp;exp=\d+"/,
		);
	});

	test("deduplicates html-block persistence within and across concurrent renders", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const duplicateState = createR2State();
		const duplicateSource = ["[[html]]<p>same</p>[[/html]]", "[[html]]<p>same</p>[[/html]]"].join(
			"\n",
		);

		await renderWikitext(duplicateSource, createEnv(sqlite, { r2State: duplicateState }), {
			pageName: "duplicate-page",
			category: "public",
			persistHtmlBlocks: true,
		});

		expect(duplicateState.headCalls).toHaveLength(1);
		expect(duplicateState.putCalls).toHaveLength(1);

		const concurrentState = createR2State();
		const concurrentEnv = createEnv(sqlite, { r2State: concurrentState });
		await Promise.all([
			renderWikitext(duplicateSource, concurrentEnv, {
				pageName: "concurrent-page",
				category: "public",
				persistHtmlBlocks: true,
			}),
			renderWikitext(duplicateSource, concurrentEnv, {
				pageName: "concurrent-page",
				category: "public",
				persistHtmlBlocks: true,
			}),
		]);

		expect(concurrentState.successfulWrites).toBe(1);
		expect(
			concurrentState.putCalls.every(
				(call) =>
					!(call.options.onlyIf instanceof Headers) &&
					call.options.onlyIf?.etagDoesNotMatch === "*",
			),
		).toBe(true);
	});

	test("applies include visibility and page tags through the processing context", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name, source) VALUES
				(1, 'public', 'public-include', 'PUBLIC_INCLUDE'),
				(2, 'share', 'share-include', 'SHARE_INCLUDE'),
				(3, 'private', 'private-include', 'PRIVATE_INCLUDE');
		`);

		const result = await renderWikitext(
			[
				"[[include public-include]]",
				"[[include share-include]]",
				"[[include private-include]]",
				"[[iftags +visible]]MATCHED_TAG[[/iftags]]",
				"[[iftags -visible]]UNMATCHED_TAG[[/iftags]]",
			].join("\n"),
			createEnv(sqlite),
			{ pageName: "start", category: "_default", tags: ["visible"] },
		);

		expect(result.html).toContain("PUBLIC_INCLUDE");
		expect(result.html).toContain("SHARE_INCLUDE");
		expect(result.html).not.toContain("PRIVATE_INCLUDE");
		expect(result.html).toContain("MATCHED_TAG");
		expect(result.html).not.toContain("UNMATCHED_TAG");
	});

	test("normalizes local ULID include targets without relying on their category spelling", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		sqlite.run(
			`INSERT INTO pages (id, category, unix_name, source) VALUES (1, 'public', '${ulid}', 'ULID_INCLUDE')`,
		);

		const result = await renderWikitext(
			[`[[include ${ulid.toUpperCase()}/offset/1]]`, `[[include docs:${ulid.toUpperCase()}]]`].join(
				"\n",
			),
			createEnv(sqlite),
			{ pageName: "start", category: "_default" },
		);

		expect(result.html.match(/ULID_INCLUDE/g)).toHaveLength(2);
	});

	test("passes urlPath to ListPages @URL query resolution", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name, title) VALUES
				(1, '_default', 'alpha', 'Alpha'),
				(2, '_default', 'beta', 'Beta');
		`);

		const result = await renderWikitext(
			[
				'[[module ListPages order="titleAsc" offset="@URL|0" limit="1"]]',
				"%%title%%",
				"[[/module]]",
			].join("\n"),
			createEnv(sqlite),
			{
				pageName: "start",
				category: "_default",
				urlPath: "/start/offset/1",
			},
		);

		expect(result.html).toContain("Beta");
		expect(result.html).not.toContain("Alpha");
	});
});
