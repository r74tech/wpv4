import { Database } from "bun:sqlite";

export function createD1(sqlite: Database): D1Database {
	const prepare = (query: string) => ({
		bind(...params: unknown[]) {
			const statement = sqlite.query(query);
			return {
				all: async () => ({ results: statement.all(...params) }),
				raw: async () => statement.values(...params),
				first: async (column?: string) => {
					const row = statement.get(...params) as Record<string, unknown> | null;
					return column ? (row?.[column] ?? null) : row;
				},
				run: async () => {
					const result = statement.run(...params);
					return {
						success: true,
						results: [],
						meta: {
							changes: result.changes,
							last_row_id: Number(result.lastInsertRowid),
						},
					};
				},
			};
		},
	});

	return {
		prepare,
		async batch(statements) {
			sqlite.run("BEGIN");
			try {
				const results = [];
				for (const statement of statements) results.push(await statement.all());
				sqlite.run("COMMIT");
				return results;
			} catch (error) {
				sqlite.run("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
}

export async function applyMigrations(sqlite: Database, through = 5): Promise<void> {
	for (let number = 1; number <= through; number += 1) {
		const names = [
			"0001_initial.sql",
			"0002_normalize_page_tags.sql",
			"0003_add_avatar_unix_name.sql",
			"0004_api_keys.sql",
			"0005_soft_delete_and_api_audit.sql",
		];
		const file = Bun.file(new URL(`../../db/migrations/${names[number - 1]}`, import.meta.url));
		sqlite.run(await file.text());
	}
}
