import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { apiKeys, users } from "@/db/schema";
import {
	MAX_ACTIVE_API_KEYS,
	apiKeyStatus,
	generateApiKey,
	parseScopes,
	type ApiKeyExpiryDays,
	type ApiKeyScope,
} from "@/lib/api-key";
import { hashToken } from "@/middleware/session";

type Db = ReturnType<typeof drizzle>;

export type ListedApiKey = {
	id: number;
	name: string;
	hint: string;
	scopes: ApiKeyScope[];
	status: "active" | "revoked" | "expired";
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
};

export async function createApiKey(
	db: Db,
	input: {
		userId: number;
		name: string;
		scopes: ApiKeyScope[];
		expiresInDays: ApiKeyExpiryDays;
		now: Date;
	},
): Promise<
	| {
			ok: true;
			id: number;
			plaintext: string;
			hint: string;
			expiresAt: string | null;
	  }
	| { ok: false; code: "limit_exceeded" }
> {
	const { plaintext, hint } = generateApiKey();
	const keyHash = await hashToken(plaintext);
	const now = input.now.toISOString();
	const expiresAt =
		input.expiresInDays === null
			? null
			: new Date(input.now.getTime() + input.expiresInDays * 86_400_000).toISOString();
	const rows = await db.all<{ id: number }>(sql`
		INSERT INTO api_keys
			(user_id, name, key_hash, key_hint, scopes, expires_at, created_at)
		SELECT
			${input.userId}, ${input.name}, ${keyHash}, ${hint}, ${JSON.stringify(input.scopes)}, ${expiresAt}, ${now}
		WHERE (
			SELECT COUNT(*) FROM api_keys
			WHERE user_id = ${input.userId}
				AND deleted_at IS NULL
				AND revoked_at IS NULL
				AND (expires_at IS NULL OR expires_at > ${now})
		) < ${MAX_ACTIVE_API_KEYS}
		RETURNING id
	`);
	if (rows.length === 0) return { ok: false, code: "limit_exceeded" };
	return { ok: true, id: rows[0].id, plaintext, hint, expiresAt };
}

export async function listApiKeys(
	db: Db,
	userId: number,
	now = new Date(),
): Promise<ListedApiKey[]> {
	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			hint: apiKeys.keyHint,
			scopes: apiKeys.scopes,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
			expiresAt: apiKeys.expiresAt,
			revokedAt: apiKeys.revokedAt,
		})
		.from(apiKeys)
		.where(and(eq(apiKeys.userId, userId), isNull(apiKeys.deletedAt)))
		.orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
	return rows.map((row) => ({
		...row,
		scopes: parseScopes(row.scopes),
		status: apiKeyStatus(row, now),
	}));
}

export async function updateApiKey(
	db: Db,
	userId: number,
	id: number,
	patch: { name?: string; scopes?: ApiKeyScope[] },
): Promise<number> {
	const values: { name?: string; scopes?: string } = {};
	if (patch.name !== undefined) values.name = patch.name;
	if (patch.scopes !== undefined) values.scopes = JSON.stringify(patch.scopes);
	const rows = await db
		.update(apiKeys)
		.set(values)
		.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.deletedAt)))
		.returning({ id: apiKeys.id });
	return rows.length;
}

export async function revokeApiKey(db: Db, userId: number, id: number, now: Date): Promise<number> {
	const rows = await db
		.update(apiKeys)
		.set({ revokedAt: now.toISOString() })
		.where(
			and(
				eq(apiKeys.id, id),
				eq(apiKeys.userId, userId),
				isNull(apiKeys.revokedAt),
				isNull(apiKeys.deletedAt),
			),
		)
		.returning({ id: apiKeys.id });
	return rows.length;
}

export async function deleteApiKey(db: Db, userId: number, id: number, now: Date): Promise<number> {
	const deletedAt = now.toISOString();
	const rows = await db
		.update(apiKeys)
		.set({
			deletedAt,
			revokedAt: sql`COALESCE(${apiKeys.revokedAt}, ${deletedAt})`,
		})
		.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.deletedAt)))
		.returning({ id: apiKeys.id });
	return rows.length;
}

export async function findActiveApiKey(db: Db, plaintext: string, now: Date) {
	const keyHash = await hashToken(plaintext);
	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			scopes: apiKeys.scopes,
			expiresAt: apiKeys.expiresAt,
			userId: users.id,
			wikidotId: users.wikidotId,
			userName: users.name,
			userUnixName: users.unixName,
		})
		.from(apiKeys)
		.innerJoin(users, eq(apiKeys.userId, users.id))
		.where(
			and(
				eq(apiKeys.keyHash, keyHash),
				isNull(apiKeys.revokedAt),
				isNull(apiKeys.deletedAt),
				or(isNull(apiKeys.expiresAt), sql`${apiKeys.expiresAt} > ${now.toISOString()}`),
			),
		)
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		scopes: parseScopes(row.scopes),
		expiresAt: row.expiresAt,
		user: {
			id: row.userId,
			wikidotId: row.wikidotId,
			name: row.userName,
			unixName: row.userUnixName,
		},
	};
}

export async function touchApiKeyLastUsed(db: Db, id: number, now: Date): Promise<void> {
	const threshold = new Date(now.getTime() - 60_000).toISOString();
	await db
		.update(apiKeys)
		.set({ lastUsedAt: now.toISOString() })
		.where(
			and(
				eq(apiKeys.id, id),
				isNull(apiKeys.deletedAt),
				or(isNull(apiKeys.lastUsedAt), sql`${apiKeys.lastUsedAt} < ${threshold}`),
			),
		);
}
