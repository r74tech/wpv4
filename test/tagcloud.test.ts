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

type TagCloudAnchor = {
	tag: string;
	href: string;
	fontSize: string;
};

async function inspectTagCloudHtml(html: string): Promise<{
	anchors: TagCloudAnchor[];
	error: string;
	message: string;
}> {
	const anchors: Array<{ tag: string; href: string; style: string }> = [];
	let error = "";
	let message = "";
	const response = new HTMLRewriter()
		.on(".pages-tag-cloud-box a.tag", {
			element(element) {
				anchors.push({
					tag: "",
					href: element.getAttribute("href") ?? "",
					style: element.getAttribute("style") ?? "",
				});
			},
			text(text) {
				const anchor = anchors.at(-1);
				if (anchor) anchor.tag += text.text;
			},
		})
		.on(".error-block", {
			text(text) {
				error += text.text;
			},
		})
		.on("p", {
			text(text) {
				message += text.text;
			},
		})
		.transform(new Response(html));
	await response.text();

	return {
		anchors: anchors.map(({ tag, href, style }) => ({
			tag,
			href,
			fontSize: /(?:^|;)\s*font-size:\s*([^;]+)/.exec(style)?.[1]?.trim() ?? "",
		})),
		error,
		message,
	};
}

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
			unix_name TEXT NOT NULL,
			created_by INTEGER
		);
		CREATE TABLE page_tags (
			id INTEGER PRIMARY KEY,
			page_id INTEGER NOT NULL,
			tag TEXT NOT NULL
		);
	`);
	return sqlite;
}

function createEnv(sqlite: Database, executions: QueryExecution[] = []): Bindings {
	return {
		DB: createD1Adapter(sqlite, executions),
		R2: {} as R2Bucket,
		OAUTH_PROVIDER_URL: "",
		CLIENT_ID: "",
		CLIENT_SECRET: "",
		SESSION_SECRET: "",
		FILES_DOMAIN: "https://files.example.com",
		FILES_URL_SECRET: "test-secret",
	};
}

const databases: Database[] = [];

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

describe("renderWikitext TagCloud", () => {
	test("renders weights from public pages without hidden tags", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name) VALUES
				(1, 'public', 'one'),
				(2, 'public', 'two'),
				(3, 'share', 'shared'),
				(4, 'private', 'private');
			INSERT INTO page_tags (page_id, tag) VALUES
				(1, 'common'), (1, 'secondary'), (1, '_hidden'),
				(2, 'common'),
				(3, 'shared-only'),
				(4, 'private-only');
		`);

		const result = await renderWikitext("[[module TagCloud]]", createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});

		expect(await inspectTagCloudHtml(result.html)).toEqual({
			anchors: [
				{ tag: "common", href: "/system:page-tags/tag/common", fontSize: "300%" },
				{
					tag: "secondary",
					href: "/system:page-tags/tag/secondary",
					fontSize: "100%",
				},
			],
			error: "",
			message: "",
		});
	});

	test("normalizes a category and adds it to tag links", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name) VALUES
				(1, 'news-foo', 'article'),
				(2, 'public', 'other');
			INSERT INTO page_tags (page_id, tag) VALUES
				(1, 'announcement'),
				(2, 'unrelated');
		`);

		const result = await renderWikitext(
			'[[module TagCloud category="News Foo"]]',
			createEnv(sqlite),
			{
				pageName: "start",
				category: "_default",
			},
		);

		expect((await inspectTagCloudHtml(result.html)).anchors).toEqual([
			{
				tag: "announcement",
				href: "/system:page-tags/tag/announcement/category/news-foo",
				fontSize: "100%",
			},
		]);
	});

	test("distinguishes an existing category without tags from a missing category", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run("INSERT INTO pages (id, category, unix_name) VALUES (1, 'empty-news', 'article')");

		const existing = await renderWikitext(
			'[[module TagCloud category="empty-news"]]',
			createEnv(sqlite),
			{
				pageName: "start",
				category: "_default",
			},
		);
		const missing = await renderWikitext(
			'[[module TagCloud category="missing"]]',
			createEnv(sqlite),
			{
				pageName: "start",
				category: "_default",
			},
		);

		expect(await inspectTagCloudHtml(existing.html)).toEqual({
			anchors: [],
			error: "",
			message:
				"It seems you have no tags attached to pages. To attach a tag simply click on the tags button at the bottom of any page.",
		});
		expect(await inspectTagCloudHtml(missing.html)).toEqual({
			anchors: [],
			error: 'Category "missing" can not be found.',
			message: "",
		});
	});

	test("does not reveal that a private category exists", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name) VALUES (1, 'private', 'secret-page');
			INSERT INTO page_tags (page_id, tag) VALUES (1, 'secret-tag');
		`);

		const result = await renderWikitext(
			'[[module TagCloud category="private"]]',
			createEnv(sqlite),
			{
				pageName: "start",
				category: "_default",
			},
		);

		expect(await inspectTagCloudHtml(result.html)).toEqual({
			anchors: [],
			error: 'Category "private" can not be found.',
			message: "",
		});
	});

	test("binds untrusted category and limit values instead of interpolating SQL", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];
		const rawCategory = "Public' OR 1=1 --";
		const normalizedCategory = "public-or-1-1";
		sqlite.run("INSERT INTO pages (id, category, unix_name) VALUES (1, ?, 'article')", [
			normalizedCategory,
		]);
		sqlite.run("INSERT INTO page_tags (page_id, tag) VALUES (1, 'visible')");

		await renderWikitext(
			`[[module TagCloud category="${rawCategory}" limit="7"]]`,
			createEnv(sqlite, executions),
			{
				pageName: "start",
				category: "_default",
			},
		);

		expect(
			executions.map(({ sql, params }) => ({
				interpolatesRawCategory: sql.includes(rawCategory),
				interpolatesNormalizedCategory: sql.includes(normalizedCategory),
				params,
			})),
		).toEqual([
			{
				interpolatesRawCategory: false,
				interpolatesNormalizedCategory: false,
				params: ["share", "private", normalizedCategory, 1],
			},
			{
				interpolatesRawCategory: false,
				interpolatesNormalizedCategory: false,
				params: ["share", "private", "_", normalizedCategory, 7],
			},
		]);
	});
});
