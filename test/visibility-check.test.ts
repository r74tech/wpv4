import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/d1";
import { findReferencingPages } from "../src/services/visibility-check";

type BoundStatement = {
	raw(): Promise<unknown[][]>;
	all(): Promise<{ results: Record<string, unknown>[] }>;
};

function createD1Adapter(sqlite: Database): D1Database {
	return {
		prepare(query: string) {
			return {
				bind(...params: unknown[]): BoundStatement {
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
			created_at TEXT,
			updated_at TEXT,
			deleted_by INTEGER,
			deleted_at TEXT
		);
	`);
	return sqlite;
}

describe("findReferencingPages", () => {
	const databases: Database[] = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	test("uses WDPR include targets and the same local target normalization as fetching", async () => {
		const sqlite = createDatabase();
		databases.push(sqlite);
		const ulid = "01arz3ndektsv4rrffq69g5fav";
		const upper = ulid.toUpperCase();
		const rows: Array<[number, string, string, string, string, number | null]> = [
			[1, "public", ulid, "Self", "", 7],
			[2, "_default", "direct-public", "Direct public", `[[include public:${upper}]]`, 7],
			[3, "share", "bare", "Bare", `[[include ${upper}]]`, 7],
			[4, "docs", "suffix", "Suffix", `[[include docs:${upper}/offset/1]]`, 7],
			[5, "_default", "inline", "Inline", `prefix [[include public:${ulid}]]`, 7],
			[6, "_default", "variable", "Variable", `[[include template |target=${ulid}]]`, 7],
			[7, "_default", "cross-site", "Cross-site", `[[include :scp-jp:public:${ulid}]]`, 7],
			[8, "private", "hidden", "Hidden", `[[include private:${ulid}]]`, 99],
			[9, "private", "owned", "Owned", `[[include private:${ulid}]]`, 7],
			[10, "share", "same-site", "Same site", `[[include :wpv4:public:${upper}]]`, 7],
			[11, "share", "semicolon", "Semicolon", `[[include public;${upper}]]`, 7],
		];
		const insert = sqlite.prepare(
			"INSERT INTO pages (id, category, unix_name, title, source, created_by) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const row of rows) insert.run(...row);

		const result = await findReferencingPages(drizzle(createD1Adapter(sqlite)), upper, 1, 7);

		expect(result.visible.map((page) => page.id)).toEqual([2, 3, 4, 7, 9, 10, 11]);
		expect(result.hiddenCount).toBe(1);
	});
});
