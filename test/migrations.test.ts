import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyMigrationSql, applyMigrations } from "./helpers/d1";

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
			expect(tables.map(({ name }) => name)).toContain("custom_rating_axes");
			expect(tables.map(({ name }) => name)).toContain("custom_votes");
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

	test("records current tags only on the latest revision when adding revision tags", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite, 8);
			sqlite.run(
				"INSERT INTO pages (id, category, unix_name, revision_count) VALUES (1, 'docs', 'article', 1), (2, 'docs', 'empty', 0)",
			);
			sqlite.run("INSERT INTO revisions (page_id, revision_number) VALUES (1, 0), (1, 1), (2, 0)");
			sqlite.run("INSERT INTO page_tags (page_id, tag) VALUES (1, 'beta'), (1, 'alpha')");
			applyMigrationSql(
				sqlite,
				await Bun.file(new URL("../db/migrations/0009_revision_tags.sql", import.meta.url)).text(),
			);
			expect(
				sqlite.query("SELECT page_id, revision_number, tags FROM revisions ORDER BY id").all(),
			).toEqual([
				{ page_id: 1, revision_number: 0, tags: null },
				{ page_id: 1, revision_number: 1, tags: '["beta","alpha"]' },
				{ page_id: 2, revision_number: 0, tags: "[]" },
			]);
			expect(() => sqlite.run("UPDATE revisions SET tags = 'invalid' WHERE page_id = 2")).toThrow();
		} finally {
			sqlite.close();
		}
	});

	test("adds custom rating storage while preserving existing votes", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite, 7);
			sqlite.run("INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 1, 'A', 'a')");
			sqlite.run(
				"INSERT INTO pages (id, category, unix_name) VALUES (1, 'docs', 'article'), (2, 'docs', 'other')",
			);
			sqlite.run("INSERT INTO votes (id, page_id, user_id, value) VALUES (1, 1, 1, -1)");
			const before = sqlite.query("SELECT * FROM votes").all();
			applyMigrationSql(
				sqlite,
				await Bun.file(new URL("../db/migrations/0008_custom_ratings.sql", import.meta.url)).text(),
			);
			expect(sqlite.query("SELECT * FROM votes").all()).toEqual(before);
			expect(sqlite.query("SELECT * FROM custom_rating_axes").all()).toEqual([]);
			expect(sqlite.query("SELECT * FROM custom_votes").all()).toEqual([]);
			sqlite.run(
				"INSERT INTO custom_rating_axes (id, key, label, up_label, neutral_label, down_label) VALUES (1, 'Quality', '品質', '▲', '■', '▼'), (2, 'quality', 'quality', NULL, NULL, NULL)",
			);
			sqlite.run(
				"INSERT INTO custom_votes (page_id, axis_id, user_id, value) VALUES (1, 1, 1, 0), (1, 2, 1, 1), (2, 1, 1, -1)",
			);
			expect(
				sqlite.query("SELECT value FROM custom_votes WHERE page_id=1 AND axis_id=1").get(),
			).toEqual({ value: 0 });
			expect(
				sqlite
					.query("SELECT up_label, neutral_label, down_label FROM custom_rating_axes WHERE id=1")
					.get(),
			).toEqual({ up_label: "▲", neutral_label: "■", down_label: "▼" });
			for (const query of [
				"INSERT INTO custom_rating_axes (key, label) VALUES ('Quality', 'duplicate')",
				"INSERT INTO custom_rating_axes (key, label) VALUES ('', 'empty')",
				"INSERT INTO custom_votes (page_id, axis_id, user_id, value) VALUES (1, 1, 1, 1)",
				"INSERT INTO custom_votes (page_id, axis_id, user_id, value) VALUES (2, 2, 1, 2)",
				"INSERT INTO custom_votes (page_id, axis_id, user_id, value) VALUES (2, 999, 1, 1)",
				"INSERT INTO custom_votes (page_id, axis_id, user_id, value) VALUES (2, 2, 999, 1)",
				"INSERT INTO custom_votes (page_id, axis_id, user_id, value) VALUES (999, 2, 1, 1)",
				"DELETE FROM custom_rating_axes WHERE id=1",
			])
				expect(() => sqlite.run(query)).toThrow();
			sqlite.run("UPDATE pages SET category='share', deleted_at='2026-09-13' WHERE id=1");
			expect(
				sqlite.query("SELECT COUNT(*) AS count FROM custom_votes WHERE page_id=1").get(),
			).toEqual({ count: 2 });
			sqlite.run("DELETE FROM pages WHERE id=1");
			expect(sqlite.query("SELECT page_id, axis_id, value FROM custom_votes").all()).toEqual([
				{ page_id: 2, axis_id: 1, value: -1 },
			]);
			expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	test("adds migration 0004 to an existing database and enforces checks", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite, 3);
			const migration = Bun.file(new URL("../db/migrations/0004_api_keys.sql", import.meta.url));
			applyMigrationSql(sqlite, await migration.text());
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
			applyMigrationSql(sqlite, await migration.text());

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
			applyMigrationSql(sqlite, await migration.text());

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

	test("scopes page unix names by category without losing related rows", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite, 6);
			sqlite.run("INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 1, 'A', 'a')");
			sqlite.run(
				"INSERT INTO pages (id, category, unix_name, title, created_by) VALUES (1, 'credit', 'start', 'Credit', 1)",
			);
			sqlite.run(
				"INSERT INTO pages (id, category, unix_name, title, created_by) VALUES (100, 'deleted', 'old', 'Deleted', 1)",
			);
			sqlite.run("DELETE FROM pages WHERE id = 100");
			sqlite.run(
				"INSERT INTO revisions (id, page_id, revision_number, title, created_by) VALUES (1, 1, 0, 'Credit', 1)",
			);
			sqlite.run("INSERT INTO page_tags (id, page_id, tag) VALUES (1, 1, 'module')");
			sqlite.run("INSERT INTO votes (id, page_id, user_id, value) VALUES (1, 1, 1, 1)");
			sqlite.run(
				"INSERT INTO api_audit_events (id, user_id, action, page_id, page_path, status_code, response_json) VALUES (1, 1, 'page.create', 1, 'credit:start', 201, '{}')",
			);

			const migration = Bun.file(
				new URL("../db/migrations/0007_scope_page_unix_name_by_category.sql", import.meta.url),
			);
			applyMigrationSql(sqlite, await migration.text());
			sqlite.run(
				"INSERT INTO pages (category, unix_name, title, created_by) VALUES ('wiki-syntax', 'start', 'Syntax', 1)",
			);
			sqlite.run(
				"INSERT INTO pages (category, unix_name, title, created_by) VALUES ('another-fixed', 'start', 'Also allowed', 1)",
			);
			expect(sqlite.query("SELECT id FROM pages WHERE category = 'wiki-syntax'").get()).toEqual({
				id: 101,
			});

			expect(() =>
				sqlite.run(
					"INSERT INTO pages (category, unix_name, title, created_by) VALUES ('wiki-syntax', 'start', 'Duplicate', 1)",
				),
			).toThrow();
			const ulid = "01arz3ndektsv4rrffq69g5fav";
			sqlite.run(
				"INSERT INTO pages (category, unix_name, title, created_by) VALUES ('public', ?, 'Managed', 1)",
				[ulid],
			);
			expect(() =>
				sqlite.run(
					"INSERT INTO pages (category, unix_name, title, created_by) VALUES ('fixed', ?, 'Collision', 1)",
					[ulid],
				),
			).toThrow();
			expect(() =>
				sqlite.run(
					"INSERT INTO pages (category, unix_name, title, created_by) VALUES ('private', ?, 'Collision', 1)",
					[ulid],
				),
			).toThrow();
			expect(sqlite.query("SELECT count(*) AS count FROM revisions").get()).toEqual({
				count: 1,
			});
			expect(sqlite.query("SELECT count(*) AS count FROM page_tags").get()).toEqual({
				count: 1,
			});
			expect(sqlite.query("SELECT count(*) AS count FROM votes").get()).toEqual({ count: 1 });
			expect(sqlite.query("SELECT count(*) AS count FROM api_audit_events").get()).toEqual({
				count: 1,
			});
			expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});
