import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { moveHtmlBlocksForVisibilityChange, renderWikitext } from "../src/services/pipeline";
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
	deleteCalls: string[];
	successfulWrites: number;
	onSuccessfulPut?: () => void;
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
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			wikidot_id INTEGER NOT NULL,
			name TEXT NOT NULL,
			unix_name TEXT NOT NULL,
			avatar_unix_name TEXT
		);
		CREATE TABLE pages (
			id INTEGER PRIMARY KEY,
			category TEXT NOT NULL,
			unix_name TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '',
			revision_count INTEGER DEFAULT 0,
			is_locked INTEGER NOT NULL DEFAULT 0,
			created_by INTEGER,
			updated_by INTEGER,
			deleted_by INTEGER,
			created_at TEXT DEFAULT '2026-07-24T00:00:00.000Z',
			updated_at TEXT DEFAULT '2026-07-24T00:00:00.000Z',
			deleted_at TEXT,
			UNIQUE(category, unix_name)
		);
		CREATE TABLE page_tags (
			id INTEGER PRIMARY KEY,
			page_id INTEGER NOT NULL,
			tag TEXT NOT NULL
		);
		CREATE TABLE votes (
			id INTEGER PRIMARY KEY,
			page_id INTEGER NOT NULL,
			user_id INTEGER NOT NULL,
			value INTEGER NOT NULL CHECK(value IN (-1, 1)),
			created_at TEXT,
			UNIQUE(page_id, user_id)
		);
	`);
	return sqlite;
}

function createR2State(): R2State {
	return {
		keys: new Set(),
		headCalls: [],
		putCalls: [],
		deleteCalls: [],
		successfulWrites: 0,
	};
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
			state.onSuccessfulPut?.();
			return { key } as R2Object;
		},
		async delete(keys: string | string[]) {
			for (const key of typeof keys === "string" ? [keys] : keys) {
				state.deleteCalls.push(key);
				state.keys.delete(key);
			}
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
		AVATARS: {} as R2Bucket,
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
	test("routes avatar user markup through the files domain", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(
			"INSERT INTO users (id, wikidot_id, name, unix_name, avatar_unix_name) VALUES (1, 4053112, 'User', 'user', 'user')",
		);

		const rendered = await renderWikitext("[[*user USER]]", createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});

		expect(rendered.html).toContain('src="https://files.example.com/avatar?userId=4053112"');
		expect(rendered.html).toContain('href="https://www.wikidot.com/user:info/user"');
	});

	test("uses the default avatar ID for an unknown user", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);

		const rendered = await renderWikitext("[[*user missing]]", createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});

		expect(rendered.html).toContain('src="https://files.example.com/avatar?userId=-1"');
		expect(rendered.html).toContain('href="https://www.wikidot.com/user:info/missing"');
	});

	test("uses the default avatar ID when ownership is ambiguous", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO users (id, wikidot_id, name, unix_name, avatar_unix_name) VALUES
				(1, 1, 'Old', 'shared-name', 'shared-name'),
				(2, 2, 'New', 'shared-name', 'shared-name');
		`);

		const rendered = await renderWikitext("[[*user SHARED-NAME]]", createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});

		expect(rendered.html).toContain('src="https://files.example.com/avatar?userId=-1"');
	});

	test("limits avatar ownership lookup to 100 normalized names", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];
		const source = Array.from({ length: 101 }, (_, index) => `[[*user user-${index}]]`).join("\n");

		const rendered = await renderWikitext(source, createEnv(sqlite, { executions }), {
			pageName: "start",
			category: "_default",
		});
		const lookup = executions.find(({ sql }) => sql.includes("avatar_unix_name"));

		expect(lookup?.params).toHaveLength(100);
		expect(rendered.html.match(/avatar\?userId=-1/g)).toHaveLength(101);
	});

	test("finds avatar users in renderer side channels and non-generic child branches", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO users (id, wikidot_id, name, unix_name, avatar_unix_name) VALUES
				(1, 101, 'Footnote', 'footnote-user', 'footnote-user'),
				(2, 102, 'If', 'if-user', 'if-user'),
				(3, 103, 'IfExpr', 'ifexpr-user', 'ifexpr-user'),
				(4, 104, 'Bibliography', 'bibliography-user', 'bibliography-user'),
				(5, 105, 'Tab', 'tab-user', 'tab-user');
		`);
		const source = [
			"Body[[footnote]][[*user footnote-user]][[/footnote]]",
			"[[footnoteblock]]",
			"[[#if true | [[*user if-user]] | hidden ]]",
			"[[#ifexpr 1 | [[*user ifexpr-user]] | hidden ]]",
			"[[bibliography]]",
			": ref : [[*user bibliography-user]]",
			"[[/bibliography]]",
			"[[tabview]]",
			"[[tab User]][[*user tab-user]][[/tab]]",
			"[[/tabview]]",
		].join("\n");

		const rendered = await renderWikitext(source, createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});

		for (const id of [101, 102, 103, 104, 105]) {
			expect(rendered.html).toContain(`avatar?userId=${id}`);
		}
	});

	test("looks up avatar ownership only for rendered users", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];
		sqlite.run(
			"INSERT INTO users (id, wikidot_id, name, unix_name, avatar_unix_name) VALUES (1, 101, 'Visible', 'visible-user', 'visible-user')",
		);

		const source = [
			"[[iftags +visible]]",
			"[[*user visible-user]]",
			"[[/iftags]]",
			"[[iftags +hidden]]",
			"[[*user hidden-user]]",
			"[[/iftags]]",
		].join("\n");
		const rendered = await renderWikitext(source, createEnv(sqlite, { executions }), {
			pageName: "start",
			category: "_default",
			tags: ["visible"],
		});
		const lookup = executions.find(({ sql }) => sql.includes("avatar_unix_name"));

		expect(lookup?.params).toEqual(["visible-user"]);
		expect(rendered.html).toContain("avatar?userId=101");
		expect(rendered.html).not.toContain("hidden-user");
	});

	test("preserves WDPR async resolvers after the avatar lookup limit", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];
		const source = [
			...Array.from({ length: 101 }, (_, index) => `[[*user user-${index}]]`),
			"[[[missing-page]]]",
			"[[html]]<p>block</p>[[/html]]",
		].join("\n");

		const rendered = await renderWikitext(source, createEnv(sqlite, { executions }), {
			pageName: "start",
			category: "_default",
		});

		expect(pageExistenceQueries(executions)).toHaveLength(1);
		expect(rendered.html).toContain('class="newpage"');
		expect(rendered.html).toMatch(
			/src="https:\/\/files\.example\.com\/local--html\/start\/[a-f0-9]{64}"/,
		);
	});

	test("renders one million plain and structurally dense characters", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const env = createEnv(sqlite);
		const plain = "あ".repeat(1_000_000);
		const dense = "[[div]]x[[/div]]\n".repeat(58_823).slice(0, 1_000_000);

		const plainResult = await renderWikitext(plain, env, {
			pageName: "plain",
			category: "_default",
		});
		const denseResult = await renderWikitext(dense, env, {
			pageName: "dense",
			category: "_default",
		});

		expect(plainResult.html).toStartWith("<p>あああ");
		expect(plainResult.html).toEndWith("あああ</p>");
		expect(plainResult.styles).toEqual([]);
		expect(denseResult.html).toStartWith("<p>[[div]]x[[/div]]<br />");
		expect(denseResult.html).toEndWith("</p>");
		expect(denseResult.html.length).toBeGreaterThan(dense.length);
		expect(denseResult.styles).toEqual([]);
	});

	test("replaces malformed UTF-16 before building user URLs", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);

		const rendered = await renderWikitext("[[*user \ud800]]", createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});

		expect(rendered.html).toContain("%EF%BF%BD");
	});

	test("resolves ListUsers from the authenticated viewer once per render", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];
		sqlite.run(`
			INSERT INTO users (id, wikidot_id, name, unix_name)
			VALUES (7, 70, 'Account Name', 'account-name');
		`);
		const source = [
			'[[module ListUsers users="."]]',
			"%%number%% / %%title%% / %%name%%",
			"[[/module]]",
			'[[module ListUsers users="."]]',
			"%%name%%",
			"[[/module]]",
		].join("\n");

		const authenticated = await renderWikitext(source, createEnv(sqlite, { executions }), {
			pageName: "start",
			category: "_default",
			viewerId: 7,
		});
		const anonymous = await renderWikitext(source, createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});

		expect(authenticated.html).toContain("70 / Account Name / account-name");
		expect(authenticated.html).toContain("account-name");
		expect(executions.filter(({ sql }) => sql.toLowerCase().includes('from "users"'))).toHaveLength(
			1,
		);
		expect(anonymous.html).toBe("");
	});

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

	test("uses rendered page-link normalization for existence lookup", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name) VALUES (1, '_default', 'foo');
		`);

		const missingResult = await renderWikitext("[[[foo/bar]]]", createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});
		expect(await inspectLinks(missingResult.html)).toEqual([
			{ href: "/foo-bar", className: "newpage" },
		]);

		sqlite.run("INSERT INTO pages (id, category, unix_name) VALUES (2, '_default', 'foo-bar')");
		const existingResult = await renderWikitext("[[[foo/bar]]]", createEnv(sqlite), {
			pageName: "start",
			category: "_default",
		});

		expect(await inspectLinks(existingResult.html)).toEqual([{ href: "/foo-bar", className: "" }]);
	});

	test("preserves public and private html-block storage and URL behavior", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name) VALUES
				(1, 'public', 'public-page'),
				(2, 'private', 'private-page');
		`);
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

		for (const result of [preview, publicResult, privateResult]) {
			expect(result.html).toContain('sandbox="allow-scripts"');
		}

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
		expect(publicState.putCalls[0]!.options.onlyIf).toEqual({
			etagDoesNotMatch: "*",
		});
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

	test("removes a stale public html-block write after visibility becomes private", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run("INSERT INTO pages (id, category, unix_name) VALUES (1, 'public', 'race-page')");
		const state = createR2State();
		state.onSuccessfulPut = () => {
			sqlite.run("UPDATE pages SET category = 'private' WHERE id = 1");
		};

		await renderWikitext("[[html]]<p>race</p>[[/html]]", createEnv(sqlite, { r2State: state }), {
			pageName: "race-page",
			category: "public",
			persistHtmlBlocks: true,
		});

		expect(state.successfulWrites).toBe(1);
		expect(state.deleteCalls).toEqual([state.putCalls[0]!.key]);
		expect(state.keys).toEqual(new Set());
	});

	test("deduplicates html-block persistence within and across concurrent renders", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name) VALUES
				(1, 'public', 'duplicate-page'),
				(2, 'public', 'concurrent-page');
		`);
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

	test("restores already moved html-blocks when a visibility move fails partway", async () => {
		const objects = new Map([
			["local--html/page/a", "A"],
			["local--html/page/b", "B"],
		]);
		let privateWrites = 0;
		const r2 = {
			async list({ prefix }: { prefix: string }) {
				return {
					objects: [...objects.keys()]
						.filter((key) => key.startsWith(prefix))
						.map((key) => ({ key })),
					truncated: false,
				};
			},
			async get(key: string) {
				const value = objects.get(key);
				return value === undefined ? null : { body: value, httpMetadata: {} };
			},
			async put(key: string, value: string) {
				if (key.startsWith("private--html/") && ++privateWrites === 2) {
					throw new Error("simulated R2 failure");
				}
				objects.set(key, value);
			},
			async delete(key: string) {
				objects.delete(key);
			},
		} as unknown as R2Bucket;

		await expect(
			moveHtmlBlocksForVisibilityChange(r2, "page", "public", "private"),
		).rejects.toThrow("simulated R2 failure");
		expect([...objects.entries()].sort()).toEqual([
			["local--html/page/a", "A"],
			["local--html/page/b", "B"],
		]);
	});

	test("applies include visibility and page tags through the processing context", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO users (id, wikidot_id, name, unix_name, avatar_unix_name)
			VALUES (1, 4053112, 'User', 'user', 'user');
			INSERT INTO pages (id, category, unix_name, source) VALUES
				(1, 'public', 'public-include', 'PUBLIC_INCLUDE [[*user user]]'),
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
		expect(result.html).toContain("avatar?userId=4053112");
		expect(result.html).toContain("SHARE_INCLUDE");
		expect(result.html).not.toContain("PRIVATE_INCLUDE");
		expect(result.html).toContain("MATCHED_TAG");
		expect(result.html).not.toContain("UNMATCHED_TAG");
	});

	test("resolves an explicit include category when unix names overlap", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name, source) VALUES
				(1, 'wiki-syntax', 'start', 'SYNTAX_START'),
				(2, 'credit', 'start', 'CREDIT_START');
		`);

		const result = await renderWikitext("[[include credit:start]]", createEnv(sqlite), {
			pageName: "start",
			category: "wiki-syntax",
		});

		expect(result.html).toContain("CREDIT_START");
		expect(result.html).not.toContain("SYNTAX_START");
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

	test("excludes soft-deleted pages from include and ListPages", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name, title, source, deleted_at) VALUES
				(1, '_default', 'active', 'ACTIVE_PAGE', 'ACTIVE_SOURCE', NULL),
				(2, '_default', 'removed', 'REMOVED_PAGE', 'REMOVED_SOURCE', '2026-09-02T00:00:00.000Z');
		`);
		const result = await renderWikitext(
			[
				"[[include removed]]",
				'[[module ListPages order="titleAsc"]]',
				"%%title%%",
				"[[/module]]",
			].join("\n"),
			createEnv(sqlite),
			{ pageName: "start", category: "_default" },
		);
		expect(result.html).toContain("ACTIVE_PAGE");
		expect(result.html).not.toContain("REMOVED_PAGE");
		expect(result.html).not.toContain("REMOVED_SOURCE");
	});

	test("preserves Rate as a read-only aggregate of the displayed page", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name, source) VALUES
				(1, 'docs', 'article', '[[module Rate]]'),
				(2, 'parts', 'rate', '[[module Rate]]');
			INSERT INTO votes (page_id, user_id, value) VALUES
				(1, 1, 1), (1, 2, 1), (1, 3, -1), (2, 1, -1);
		`);
		const result = await renderWikitext(
			"[[module Rate]]\n[[include parts:rate]]",
			createEnv(sqlite),
			{ pageName: "article", category: "docs", viewerId: 1 },
		);
		expect(result.html.match(/data-rating-kind="main"/g)).toHaveLength(2);
		expect(result.html.match(/class="number prw54353">\+1<\/span>/g)).toHaveLength(2);
		expect(result.html).not.toContain("data-rating-action=");
		expect(sqlite.query("SELECT COUNT(*) AS count FROM votes").get()).toEqual({ count: 4 });
	});

	test.each([null, 1, 2])(
		"uses the viewer's page access when reading ratings: %s",
		async (viewerId) => {
			const sqlite = createDatabase();
			databases.push(sqlite);
			sqlite.run(`
			INSERT INTO pages (id, category, unix_name, created_by, deleted_at) VALUES
				(1, 'private', 'article', 1, NULL),
				(2, 'docs', 'deleted', 1, '2026-09-13');
			INSERT INTO votes (page_id, user_id, value) VALUES (1, 1, 1), (2, 1, -1);
		`);
			const result = await renderWikitext("[[module Rate]]", createEnv(sqlite), {
				pageName: "article",
				category: "private",
				viewerId,
			});
			expect(result.html.includes('data-rating-kind="main"')).toBe(viewerId === 1);
			const deleted = await renderWikitext("[[module Rate]]", createEnv(sqlite), {
				pageName: "deleted",
				category: "docs",
				viewerId,
			});
			expect(deleted.html).toContain('class="number prw54353">0</span>');
			expect(deleted.html).not.toContain('class="number prw54353">-1</span>');
			const preview = await renderWikitext("[[module Rate]]", createEnv(sqlite), {
				pageName: "unsaved",
				category: "docs",
				viewerId,
			});
			expect(preview.html).toContain('class="number prw54353">0</span>');
			expect(preview.html).not.toContain("data-rating-action=");
		},
	);

	test("retains social markup and omits unregistered custom ratings", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const result = await renderWikitext(
			'[[social]]\n[[module CustomRate key="unregistered"]]',
			createEnv(sqlite),
			{
				pageName: "article",
				category: "docs",
			},
		);
		expect(result.html).toContain('class="wdpr-social"');
		expect(result.html).not.toContain('data-rating-kind="custom"');
	});

	test("supplies resolved text and the first body paragraph to ListPages excerpts", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(
			"INSERT INTO pages (id, category, unix_name, source) VALUES (1, 'docs', 'article', ?), (2, 'parts', 'intro', '**Hello** 日本語')",
			["+ 見出し\n\n[[include parts:intro]]\n\nSecond paragraph."],
		);
		const result = await renderWikitext(
			[
				'[[module ListPages category="docs"]]',
				"summary=%%summary%%",
				"first=%%first_paragraph%%",
				'pick=%%excerpt{pattern="Hello (日本語)" group="1"}%%',
				"preview=%%preview%%",
				"[[/module]]",
			].join("\n"),
			createEnv(sqlite),
			{ pageName: "list", category: "_default" },
		);
		expect(result.html).toMatch(/summary=<span[^>]*>Hello&#32;日本語<\/span>/);
		expect(result.html).toMatch(/first=<span[^>]*>Hello&#32;日本語<\/span>/);
		expect(result.html).toMatch(/pick=<span[^>]*>日本語<\/span>/);
		expect(result.html).toContain("Second&#32;paragraph.");
		expect(result.html).not.toContain("**Hello**");
	});

	test.each([
		["**A**日e\u0301", "3"],
		["", "0"],
		["[[code]]\nhello", "5"],
		["text\n[[include missing]]", ""],
		["[[module ListPages]]\n%%title%%\n[[/module]]", ""],
	])(
		"uses readable character counts without treating incomplete text as zero: %s",
		async (source, count) => {
			const sqlite = createDatabase();
			databases.push(sqlite);
			sqlite.run(
				"INSERT INTO pages (id, category, unix_name, source) VALUES (1, 'docs', 'article', ?)",
				[source],
			);
			const result = await renderWikitext(
				'[[module ListPages category="docs"]]\nsize=%%size%%;\n[[/module]]',
				createEnv(sqlite),
				{ pageName: "list", category: "_default" },
			);
			expect(result.html).toContain(`size=${count};`);
		},
	);

	test("uses the normal include policy when extracting ListPages text", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			INSERT INTO pages (id, category, unix_name, source, created_by) VALUES
				(1, 'docs', 'article', '[[include private:part]]', 1),
				(2, 'private', 'part', 'PRIVATE_BODY', 1);
		`);
		const result = await renderWikitext(
			'[[module ListPages category="docs"]]\ntext=%%preview%%;size=%%size%%;\n[[/module]]',
			createEnv(sqlite),
			{ pageName: "list", category: "_default", viewerId: 1 },
		);
		expect(result.html).toContain("text=;size=;");
		expect(result.html).not.toContain("PRIVATE_BODY");
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

	test.each([250, 10000])("renders at most 250 tagged items for perPage=%i", async (perPage) => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			WITH RECURSIVE sequence(id) AS (
				SELECT 1 UNION ALL SELECT id + 1 FROM sequence WHERE id < 251
			)
			INSERT INTO pages (id, category, unix_name, title)
			SELECT id, 'public', printf('sample-%03d', id), printf('Sample %03d', id) FROM sequence;
			INSERT INTO page_tags (page_id, tag) SELECT id, 'jp' FROM pages;
			INSERT INTO pages (id, category, unix_name, title, deleted_at) VALUES
				(252, 'private', 'private', 'EXCLUDED_PRIVATE', NULL),
				(253, 'share', 'share', 'EXCLUDED_SHARE', NULL),
				(254, 'public', 'deleted', 'EXCLUDED_DELETED', '2026-09-11'),
				(255, 'public', 'other', 'EXCLUDED_OTHER_TAG', NULL);
			INSERT INTO page_tags (page_id, tag) VALUES
				(252, 'jp'), (253, 'jp'), (254, 'jp'), (255, 'en');
		`);
		const executions: QueryExecution[] = [];
		const result = await renderWikitext(
			[
				`[[module ListPages tags="@URL" perPage="${perPage}" category="*" order="title asc"]]`,
				"%%title%% / %%tags%% / %%total%%",
				"[[/module]]",
			].join("\n"),
			createEnv(sqlite, { executions }),
			{ pageName: "page-tags", category: "system", urlPath: "/system:page-tags/tag/jp" },
		);

		expect(result.html.match(/class="list-pages-item"/g)).toHaveLength(250);
		expect(result.html).toContain("Sample 250 / jp / 251");
		expect(result.html).not.toContain("Sample 251");
		expect(result.html).not.toContain("EXCLUDED_");
		for (const execution of executions) expect(execution.params.length).toBeLessThanOrEqual(100);
	});

	test.each([
		{ attributes: 'perPage="5"', count: 5, first: 1 },
		{ attributes: 'limit="3" perPage="5"', count: 3, first: 1 },
		{ attributes: 'limit="30" perPage="5"', count: 5, first: 1 },
		{ attributes: 'limit="30"', count: 20, first: 1 },
		{ attributes: 'perPage="0"', count: 20, first: 1 },
		{ attributes: 'perPage="-1"', count: 20, first: 1 },
		{ attributes: 'limit="0" perPage="5"', count: 0, first: 1 },
		{ attributes: 'per_page="@URL" offset="@URL|0"', count: 5, first: 6 },
	])("applies ListPages sizing for $attributes", async ({ attributes, count, first }) => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			WITH RECURSIVE sequence(id) AS (
				SELECT 1 UNION ALL SELECT id + 1 FROM sequence WHERE id < 31
			)
			INSERT INTO pages (id, category, unix_name, title)
			SELECT id, 'public', printf('sample-%03d', id), printf('Sample %03d', id) FROM sequence;
		`);
		const result = await renderWikitext(
			`[[module ListPages category="*" order="title asc" ${attributes}]]\n%%title%%\n[[/module]]`,
			createEnv(sqlite),
			{ pageName: "start", category: "public", urlPath: "/start/per-page/5/offset/5" },
		);
		expect(result.html.match(/class="list-pages-item"/g) ?? []).toHaveLength(count);
		if (count > 0) expect(result.html).toContain(`Sample ${String(first).padStart(3, "0")}`);
	});

	test("follows the tagged ListPages pager beyond 1000 items with stable ordering", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			WITH RECURSIVE sequence(id) AS (
				SELECT 1 UNION ALL SELECT id + 1 FROM sequence WHERE id < 1251
			)
			INSERT INTO pages (id, category, unix_name, title)
			SELECT id, 'public', printf('sample-%04d', id), '同順位' FROM sequence;
			INSERT INTO page_tags (page_id, tag) SELECT id, 'jp' FROM pages;
		`);
		const env = createEnv(sqlite);
		const source = [
			'[[module ListPages tags="@URL" perPage="250" category="*" order="title asc" wrapper="no"]]',
			"%%name%% / %%index%% / %%total%%",
			"[[/module]]",
		].join("\n");
		const render = (urlPath: string) =>
			renderWikitext(source, env, { pageName: "page-tags", category: "system", urlPath });
		const first = await render("/system:page-tags/tag/jp");
		expect(first.html).toContain("sample-0001 / 1 / 1251");
		expect(first.html).toContain("page 1 of 6");
		const lastLink = (await inspectLinks(first.html)).find(({ href }) => href.endsWith("/p/6"));
		expect(lastLink?.href).toBe("/system:page-tags/tag/jp/p/6");

		for (const path of [lastLink!.href, "/system:page-tags/tag/jp/p/999"]) {
			const last = await render(path);
			expect(last.html.match(/class="list-pages-item"/g)).toHaveLength(1);
			expect(last.html).toContain("sample-1251 / 1251 / 1251");
			expect(last.html).toContain("page 6 of 6");
			expect((await inspectLinks(last.html)).some(({ href }) => href.endsWith("/p/5"))).toBe(true);
		}
	});

	test("keeps prefixed pagers independent while applying offset and total limit", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		sqlite.run(`
			WITH RECURSIVE sequence(id) AS (
				SELECT 1 UNION ALL SELECT id + 1 FROM sequence WHERE id < 12
			)
			INSERT INTO pages (id, category, unix_name, title)
			SELECT id, 'public', printf('sample-%02d', id), '同順位' FROM sequence;
		`);
		const source = [
			'[[module ListPages category="*" order="title asc" perPage="3" offset="2" limit="5" separate="no"]]',
			"main: %%name%%",
			"[[/module]]",
			'[[module ListPages category="*" order="title asc" perPage="3" urlAttrPrefix="other"]]',
			"other: %%name%%",
			"[[/module]]",
		].join("\n");
		const result = await renderWikitext(source, createEnv(sqlite), {
			pageName: "start",
			category: "public",
			urlPath: "/start/p/2/other_p/1",
		});
		expect(result.html).toContain("main: sample-06");
		expect(result.html).toContain("main: sample-07");
		expect(result.html).not.toContain("main: sample-08");
		expect(result.html).toContain("other: sample-01");
		expect(result.html).toContain("other: sample-03");
		expect(result.html).not.toContain("other: sample-04");
		expect(result.html).toContain("page 2 of 2");
		expect(result.html).toContain("page 1 of 4");
		const links = await inspectLinks(result.html);
		expect(links.some(({ href }) => href === "/start/other_p/1/p/1")).toBe(true);
		expect(links.some(({ href }) => href === "/start/p/2/other_p/2")).toBe(true);
	});

	test("filters ListPages by author and renders creator and updater metadata", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const executions: QueryExecution[] = [];
		sqlite.run(`
			INSERT INTO users (id, wikidot_id, name, unix_name, avatar_unix_name) VALUES
				(1, 74, 'Account Name', 'account-name', 'account-name'),
				(2, 200, 'Editor Name', 'editor-name', 'editor-name');
			INSERT INTO pages (id, category, unix_name, title, created_by, updated_by) VALUES
				(1, '_default', 'current', 'Current', 1, 1),
				(2, 'docs', 'alpha', 'Alpha', 1, 2),
				(3, 'docs', 'beta', 'Beta', 2, 1),
				(4, 'docs', 'gamma', 'Gamma', 1, 1),
				(5, 'docs', 'anonymous', 'Anonymous', NULL, NULL),
				(6, '_default', 'anonymous-current', 'Anonymous current', NULL, NULL);
		`);
		const template = [
			"%%title%%",
			"[[*user %%created_by_unix%%]]",
			"%%created_by%%/%%created_by_unix%%/%%created_by_id%%",
			"%%updated_by%%/%%updated_by_unix%%/%%updated_by_id%%",
		].join("|");
		const render = (createdBy: string, tracked = false, pageName = "current") =>
			renderWikitext(
				[
					`[[module ListPages category="docs" created_by="${createdBy}" order="title asc" separate="no"]]`,
					template,
					"[[/module]]",
				].join("\n"),
				createEnv(sqlite, tracked ? { executions } : {}),
				{ pageName, category: "_default" },
			);

		const named = await render("account-name", true);
		const sameAuthor = await render("=");
		const differentAuthor = await render("-=");
		const sameAnonymousAuthor = await render("=", false, "anonymous-current");
		const differentAnonymousAuthor = await render("-=", false, "anonymous-current");

		expect(named.html).toContain("Account Name/account-name/74|Editor Name/editor-name/200");
		expect(named.html).toContain("avatar?userId=74");
		expect(named.html).toContain("Account Name/account-name/74|Account Name/account-name/74");
		expect(named.html).not.toContain("Beta|");
		expect(sameAuthor.html).toContain("Alpha|");
		expect(sameAuthor.html).toContain("Gamma|");
		expect(sameAuthor.html).not.toContain("Beta|");
		expect(differentAuthor.html).toContain("Editor Name/editor-name/200");
		expect(differentAuthor.html).toContain("Anonymous|");
		expect(differentAuthor.html).not.toContain("Alpha|");
		expect(differentAuthor.html).not.toContain("Gamma|");
		expect(sameAnonymousAuthor.html).toContain("Anonymous|");
		expect(sameAnonymousAuthor.html).not.toContain("Alpha|");
		expect(differentAnonymousAuthor.html).toContain("Alpha|");
		expect(differentAnonymousAuthor.html).toContain("Beta|");
		expect(differentAnonymousAuthor.html).not.toContain("Anonymous|");
		expect(executions.filter(({ sql }) => sql.includes('"users"'))).toHaveLength(3);
	});
});
