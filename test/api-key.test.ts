import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/d1";
import {
	API_KEY_SCOPES,
	apiKeyStatus,
	generateApiKey,
	hasScope,
	isApiKeyFormat,
	parseScopes,
} from "../src/lib/api-key";
import { utf8ByteLength } from "../src/lib/bytes";
import {
	createApiKey,
	deleteApiKey,
	findActiveApiKey,
	listApiKeys,
	revokeApiKey,
	touchApiKeyLastUsed,
	updateApiKey,
} from "../src/services/api-keys";
import { applyMigrations, createD1 } from "./helpers/d1";

describe("API key domain", () => {
	test("generates unique 256-bit keys and safe hints", () => {
		const first = generateApiKey();
		const second = generateApiKey();

		expect(first.plaintext).not.toBe(second.plaintext);
		expect(first.plaintext).toHaveLength(48);
		expect(isApiKeyFormat(first.plaintext)).toBe(true);
		expect(first.hint).toMatch(/^wpv4_[A-Za-z0-9_-]{4}…[A-Za-z0-9_-]{4}$/);
	});

	test("parses only known unique scopes", () => {
		expect(parseScopes('["pages:read","render:use","unknown","render:use","pages:write"]')).toEqual(
			["pages:read", "render:use", "pages:write"],
		);
		expect(parseScopes("invalid")).toEqual([]);
		expect(hasScope(API_KEY_SCOPES, "pages:delete")).toBe(true);
	});

	test("treats an expiry instant as expired", () => {
		const now = new Date("2026-09-02T10:00:00.000Z");
		expect(apiKeyStatus({ revokedAt: null, expiresAt: now.toISOString() }, now)).toBe("expired");
		expect(apiKeyStatus({ revokedAt: now.toISOString(), expiresAt: null }, now)).toBe("revoked");
		expect(apiKeyStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
	});

	test("measures UTF-8 bytes for ASCII and Japanese", () => {
		expect(utf8ByteLength("abc")).toBe(3);
		expect(utf8ByteLength("日本語")).toBe(9);
		expect(utf8ByteLength("")).toBe(0);
	});
});

describe("API key service", () => {
	test("creates, lists, authenticates, updates, and revokes a key", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite);
			sqlite.run(
				"INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 10, 'Owner', 'owner')",
			);
			const db = drizzle(createD1(sqlite));
			const now = new Date("2026-09-02T10:00:00.000Z");

			const created = await createApiKey(db, {
				userId: 1,
				name: "Claude",
				scopes: ["pages:read", "pages:write"],
				expiresInDays: 30,
				now,
			});
			expect(created.ok).toBe(true);
			if (!created.ok) throw new Error("creation failed");
			expect(sqlite.query("SELECT key_hash FROM api_keys").get()).not.toEqual({
				key_hash: created.plaintext,
			});

			const listed = await listApiKeys(db, 1, now);
			expect(listed).toEqual([
				expect.objectContaining({
					name: "Claude",
					scopes: ["pages:read", "pages:write"],
					status: "active",
				}),
			]);
			expect(JSON.stringify(listed)).not.toContain(created.plaintext);

			const active = await findActiveApiKey(db, created.plaintext, now);
			expect(active?.user).toEqual({ id: 1, wikidotId: 10, name: "Owner", unixName: "owner" });

			expect(await updateApiKey(db, 1, created.id, { name: "Agent", scopes: ["pages:read"] })).toBe(
				1,
			);
			await touchApiKeyLastUsed(db, created.id, now);
			await touchApiKeyLastUsed(db, created.id, new Date(now.getTime() + 30_000));
			expect(sqlite.query("SELECT last_used_at FROM api_keys").get()).toEqual({
				last_used_at: now.toISOString(),
			});

			expect(await revokeApiKey(db, 1, created.id, now)).toBe(1);
			expect(await findActiveApiKey(db, created.plaintext, now)).toBeNull();
			expect(await revokeApiKey(db, 1, created.id, now)).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	test("soft-deletes an active key without losing its audit relation", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite);
			sqlite.run(
				"INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 10, 'Owner', 'owner')",
			);
			const db = drizzle(createD1(sqlite));
			const createdAt = new Date("2026-09-02T10:00:00.000Z");
			const deletedAt = new Date("2026-09-02T11:00:00.000Z");
			const created = await createApiKey(db, {
				userId: 1,
				name: "Active",
				scopes: ["pages:read"],
				expiresInDays: null,
				now: createdAt,
			});
			expect(created.ok).toBe(true);
			if (!created.ok) throw new Error("creation failed");
			sqlite.run(
				`INSERT INTO api_audit_events
					(api_key_id, user_id, action, page_path, status_code, response_json)
				 VALUES (?, 1, 'page.create', 'share:test', 201, '{}')`,
				[created.id],
			);
			expect(await deleteApiKey(db, 1, created.id, deletedAt)).toBe(1);
			expect(
				sqlite.query("SELECT revoked_at, deleted_at FROM api_keys WHERE id = ?").get(created.id),
			).toEqual({ revoked_at: deletedAt.toISOString(), deleted_at: deletedAt.toISOString() });
			expect(
				sqlite
					.query("SELECT api_key_id FROM api_audit_events WHERE api_key_id = ?")
					.get(created.id),
			).toEqual({ api_key_id: created.id });
			expect(await findActiveApiKey(db, created.plaintext, deletedAt)).toBeNull();
			expect(await updateApiKey(db, 1, created.id, { name: "Changed" })).toBe(0);
			expect(await revokeApiKey(db, 1, created.id, deletedAt)).toBe(0);
			expect(await deleteApiKey(db, 1, created.id, deletedAt)).toBe(0);
			await touchApiKeyLastUsed(db, created.id, deletedAt);
			expect(
				sqlite.query("SELECT last_used_at FROM api_keys WHERE id = ?").get(created.id),
			).toEqual({
				last_used_at: null,
			});
			expect(await listApiKeys(db, 1, deletedAt)).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	test("atomically enforces the active key limit", async () => {
		const sqlite = new Database(":memory:");
		try {
			await applyMigrations(sqlite);
			sqlite.run(
				"INSERT INTO users (id, wikidot_id, name, unix_name) VALUES (1, 10, 'Owner', 'owner')",
			);
			const db = drizzle(createD1(sqlite));
			const now = new Date("2026-09-02T10:00:00.000Z");
			let firstId: number | null = null;
			for (let index = 0; index < 20; index += 1) {
				const result = await createApiKey(db, {
					userId: 1,
					name: `Key ${index}`,
					scopes: ["pages:read"],
					expiresInDays: null,
					now,
				});
				expect(result.ok).toBe(true);
				if (index === 0 && result.ok) firstId = result.id;
			}
			const overflow = await createApiKey(db, {
				userId: 1,
				name: "Overflow",
				scopes: ["pages:read"],
				expiresInDays: null,
				now,
			});
			expect(overflow).toEqual({ ok: false, code: "limit_exceeded" });
			if (firstId === null) throw new Error("first key was not created");
			expect(await deleteApiKey(db, 1, firstId, now)).toBe(1);
			const replacement = await createApiKey(db, {
				userId: 1,
				name: "Replacement",
				scopes: ["pages:read"],
				expiresInDays: null,
				now,
			});
			expect(replacement.ok).toBe(true);
			expect(sqlite.query("SELECT count(*) AS count FROM api_keys").get()).toEqual({ count: 21 });
		} finally {
			sqlite.close();
		}
	});
});
