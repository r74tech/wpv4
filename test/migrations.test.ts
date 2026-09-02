import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyMigrations } from "./helpers/d1";

describe("database migrations", () => {
	test("applies all migrations to an empty database", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite);
			const tables = sqlite
				.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as { name: string }[];
			expect(tables.map(({ name }) => name)).toContain("api_keys");
			expect(tables.map(({ name }) => name)).toContain("api_audit_events");
			const pageColumns = sqlite.query("PRAGMA table_info(pages)").all() as { name: string }[];
			expect(pageColumns.map(({ name }) => name)).toContain("deleted_at");
			expect(pageColumns.map(({ name }) => name)).toContain("deleted_by");
			sqlite.run("INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 1, 'A', 'a')");
			expect(() =>
				sqlite.run(
					"INSERT INTO api_audit_events (user_id, action, page_path, status_code, response_json) VALUES (1, 'page.create', '(new)', 400, 'invalid')",
				),
			).toThrow();
		} finally {
			sqlite.close();
		}
	});

	test("adds migration 0004 to an existing database and enforces checks", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite, 3);
			const migration = Bun.file(new URL("../db/migrations/0004_api_keys.sql", import.meta.url));
			sqlite.run(await migration.text());
			sqlite.run("INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 1, 'A', 'a')");
			sqlite.run(
				"INSERT INTO pages (id, category, unix_name, created_by) VALUES (1, 'private', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 1)",
			);

			expect(() =>
				sqlite.run(
					"INSERT INTO api_keys (user_id, name, key_hash, key_hint, scopes) VALUES (1, 'x', 'h', 'k', 'invalid')",
				),
			).toThrow();
		} finally {
			sqlite.close();
		}
	});

	test("adds migration 0005 without losing pages and retains audit events after key deletion", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite, 4);
			sqlite.run("INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 1, 'A', 'a')");
			sqlite.run(
				"INSERT INTO pages (id, category, unix_name, title, created_by) VALUES (1, 'share', 'page', 'Kept', 1)",
			);
			sqlite.run(
				"INSERT INTO api_keys (id, user_id, name, key_hash, key_hint, scopes) VALUES (1, 1, 'key', 'hash', 'hint', '[\"pages:write\"]')",
			);
			const migration = Bun.file(
				new URL("../db/migrations/0005_soft_delete_and_api_audit.sql", import.meta.url),
			);
			sqlite.run(await migration.text());

			expect(
				sqlite.query("SELECT title, deleted_by, deleted_at FROM pages WHERE id = 1").get(),
			).toEqual({
				title: "Kept",
				deleted_by: null,
				deleted_at: null,
			});
			sqlite.run(
				"INSERT INTO api_audit_events (api_key_id, user_id, action, page_id, page_path, status_code, response_json) VALUES (1, 1, 'page.create', 1, 'share:page', 201, '{\"id\":1}')",
			);
			sqlite.run("DELETE FROM api_keys WHERE id = 1");
			expect(sqlite.query("SELECT api_key_id, response_json FROM api_audit_events").get()).toEqual({
				api_key_id: null,
				response_json: '{"id":1}',
			});
		} finally {
			sqlite.close();
		}
	});

	test("adds migration 0006 without losing API keys or audit references", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite, 5);
			sqlite.run("INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 1, 'A', 'a')");
			sqlite.run(
				"INSERT INTO api_keys (id, user_id, name, key_hash, key_hint, scopes) VALUES (1, 1, 'key', 'hash', 'hint', '[\"pages:write\"]')",
			);
			sqlite.run(
				"INSERT INTO api_audit_events (api_key_id, user_id, action, page_path, status_code, response_json) VALUES (1, 1, 'page.create', 'share:page', 201, '{}')",
			);
			const migration = Bun.file(
				new URL("../db/migrations/0006_soft_delete_api_keys.sql", import.meta.url),
			);
			sqlite.run(await migration.text());

			const columns = sqlite.query("PRAGMA table_info(api_keys)").all() as { name: string }[];
			expect(columns.map(({ name }) => name)).toContain("deleted_at");
			expect(sqlite.query("SELECT id, deleted_at FROM api_keys").get()).toEqual({
				id: 1,
				deleted_at: null,
			});
			expect(sqlite.query("SELECT api_key_id FROM api_audit_events").get()).toEqual({
				api_key_id: 1,
			});
			expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});
